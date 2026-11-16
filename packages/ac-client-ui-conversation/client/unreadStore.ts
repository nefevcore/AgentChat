// ============================================================
// ac-client-ui-conversation/client/unreadStore.ts —— 未读快照
// 持久化（刷新回放）+ 多 tab 收敛（cr-1139 读位换血）
//
// 形态沿革：v1 = {dialogId: count}（纯计数，全量覆写——多 tab 后写
// 者胜，他 tab 已清的未读会被复活）；v2 = {dialogId: {n, ts}}——
// ts = 该计数落定时刻，读写穿按 ts 合并（新不覆盖旧读位：清除侧
// n=0 带 ts 优先，增量侧仅当 ts 更新才采纳），多 tab 各自写穿不再
// 互踩。旧 v1 快照按既有「脏数据宁可消失」语义丢弃。
//
// storage 事件（同源多 tab）：他 tab 写穿 → 本 tab 内存对账——
// 以 ts 归一取每 dialog 最新态，再与内存合并（max-ts 语义）。仅
// 浏览器面（node 测试环境无 window——幂等跳过）。
// 归位/语义边界：同 v1（客户端 UI 态归 localStorage 不进后端；只记
// viewer 可见面；脏数据整份丢弃）。
// ============================================================

import type { DialogId } from './feed.ts';

/** 结构化 localStorage 面（jsdom/node 环境缺省 undefined——try/catch 兜底） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface WindowLike {
  addEventListener(type: string, h: (e: unknown) => void): void;
  removeEventListener(type: string, h: (e: unknown) => void): void;
}
const store: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;
const win: WindowLike | undefined = (globalThis as { window?: WindowLike }).window;

const KEY = 'agentchat.unread';

/** DialogId 形状校验：pair:a|b / group:g / single:s（值本身来自本包
 *  构造函数，正常路径恒合法；校验只挡持久化层的脏数据） */
function isDialogId(v: unknown): v is DialogId {
  return typeof v === 'string'
    && (v.startsWith('pair:') || v.startsWith('group:') || v.startsWith('single:'))
    && v.length > ('pair:'.length);
}

/** v2 快照条目：n = 当前未读数；ts = 该值落定时刻（多 tab 合并轴） */
export interface UnreadEntry { n: number; ts: number; }

/** 条目形状校验（脏数据丢弃） */
function isEntry(v: unknown): v is UnreadEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as { n?: unknown; ts?: unknown };
  return typeof e.n === 'number' && Number.isInteger(e.n) && e.n >= 0
    && typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts > 0;
}

/** 解析盘上快照（v2 形；v1/损坏/缺席 → null：无恢复） */
function parseSnapshot(raw: string | null | undefined): Partial<Record<DialogId, UnreadEntry>> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const v = parsed as { version?: unknown };
    if (v.version !== 2) return null; // v1 纯计数形态无法反推 ts——按脏数据语义丢弃
    const entries = (parsed as Record<string, unknown>).entries;
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return null;
    const out: Partial<Record<DialogId, UnreadEntry>> = {};
    for (const [k, e] of Object.entries(entries as Record<string, unknown>)) {
      if (!isDialogId(k) || !isEntry(e)) continue;
      if (e.n === 0) continue; // 零值不落快照（读即抹除语义保持）
      out[k as DialogId] = e;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 读快照（无记录/损坏/无 storage → null：无恢复） */
export function loadUnreadSnapshot(): Partial<Record<DialogId, UnreadEntry>> | null {
  try {
    return parseSnapshot(store?.getItem(KEY));
  } catch {
    return null;
  }
}

/**
 * 合并两条快照（多 tab / storage 事件对账轴）：逐 dialog 取 ts 较大者。
 * 「清除」也是一次带 ts 的写（n=0）——但零值不落快照，清除的表达 =
 * 该键缺席。缺席与在场合并时：在场者胜（清除侧若更新，其产物就是
 * 缺席——在场说明另一 tab 又计了新未读，ts 检验后采纳是正确语义）。
 */
export function mergeUnreadSnapshots(
  a: Partial<Record<DialogId, UnreadEntry>>,
  b: Partial<Record<DialogId, UnreadEntry>>,
): Partial<Record<DialogId, UnreadEntry>> {
  const out: Partial<Record<DialogId, UnreadEntry>> = { ...a };
  for (const [k, e] of Object.entries(b) as Array<[DialogId, UnreadEntry]>) {
    const cur = out[k as DialogId];
    if (cur === undefined || e.ts > cur.ts) out[k as DialogId] = e;
  }
  return out;
}

/**
 * 整份写回未读快照（调用方传全量映射；空映射 → 抹键）。失败静默
 * （无 localStorage 面 = 无持久化，不影响内存态）。
 */
export function saveUnreadSnapshot(counts: Partial<Record<DialogId, UnreadEntry>>): void {
  try {
    const valid = Object.fromEntries(
      Object.entries(counts).filter(([k, e]) => isDialogId(k) && isEntry(e) && e.n > 0),
    );
    if (Object.keys(valid).length === 0) {
      store?.removeItem(KEY);
      return;
    }
    store?.setItem(KEY, JSON.stringify({ version: 2, entries: valid }));
  } catch { /* ignore：不可用即无持久化 */ }
}

/**
 * 多 tab 对账订阅（storage 事件——同源他 tab 写穿时触发）：回调收合并
 * 后的快照。返回退订函数。仅浏览器面生效（node 无 window 幂等 no-op）。
 */
export function watchUnreadSnapshot(onMerged: (snap: Partial<Record<DialogId, UnreadEntry>>) => void): () => void {
  if (!win) return () => {};
  const handler = (ev: unknown) => {
    const e = ev as { key?: unknown; newValue?: unknown };
    if (e.key !== KEY) return;
    onMerged(parseSnapshot(typeof e.newValue === 'string' ? e.newValue : null) ?? {});
  };
  win.addEventListener('storage', handler);
  return () => {
    try { win.removeEventListener('storage', handler); } catch { /* ignore */ }
  };
}

/** 测试面：直接覆写持久化键（MemoryStorage 桩配合；回归测试水合用） */
export function __setUnreadSnapshotRaw(raw: string): void {
  try { store?.setItem(KEY, raw); } catch { /* ignore */ }
}
