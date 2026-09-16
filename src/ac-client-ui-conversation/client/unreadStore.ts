// ============================================================
// ac-client-ui-conversation/client/unreadStore.ts —— 未读快照
// 持久化（刷新回放）
//
// 未读数字徽章（名册 Agent/群行 + 活动栏聚合）的状态住 feed 分区
// DialogFeed.unread——纯内存 ref，此前刷新后 createFeedCore 重建即
// 全零，历史回放也不补算（历史管线只投消息不判读位），表现为
// 「未读徽章刷新后消失」。本件把未读快照记入 localStorage 单键
// agentchat.unread（与 composePrefs 同款裁决：客户端 UI 态归
// localStorage，不进后端会话文件），feed-core 工厂期水合回来。
//
// 归位说明：读写双方都是本包 feed-core（唯一写方 = 未读增量/清除
// 三处 + 水合），住 conversation 行 client；不引 DOM lib——localStorage
// 经结构化类型访问（本包进根 tsc 程序），jsdom/node 环境缺省
// undefined → try/catch 兜底无持久化。
//
// 语义边界：
//   · 快照 = 「当前未读的分 dialog 计数」，读（clearUnread/进会话）
//     即抹除该键；只记 viewer 可见面（pair 不含 viewer 的矩阵只读
//     分区/group/single 均可恢复）；
//   · 恢复值仅作徽章初值——分区 rawMessages 仍按需懒加载，未读
//     计数不触发历史拉取；
//   · 脏数据（损坏 JSON/形状不对/键非法）整份丢弃，宁可徽章消失
//     也不恢复出错误数字。
// ============================================================

import type { DialogId } from './feed.ts';

/** 结构化 localStorage 面（jsdom/node 环境缺省 undefined——try/catch 兜底） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const store: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

const KEY = 'agentchat.unread';

/** DialogId 形状校验：pair:a|b / group:g / single:s（值本身来自本包
 *  构造函数，正常路径恒合法；校验只挡持久化层的脏数据） */
function isDialogId(v: unknown): v is DialogId {
  return typeof v === 'string'
    && (v.startsWith('pair:') || v.startsWith('group:') || v.startsWith('single:'))
    && v.length > ('pair:'.length);
}

/**
 * 读取未读快照（无记录/损坏/无 storage → null：无恢复）。
 * 值为「有未读的 dialog → 正整数」映射；0/负数/非整数/非法键丢弃。
 */
export function loadUnreadSnapshot(): Partial<Record<DialogId, number>> | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Partial<Record<DialogId, number>> = {};
    for (const [k, n] of Object.entries(v)) {
      if (!isDialogId(k)) continue;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) continue;
      out[k] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null; // 损坏/不可用：无恢复
  }
}

/**
 * 整份写回未读快照（调用方传全量「有未读」映射；空映射 → 抹键）。
 * 失败静默（无 localStorage 面 = 无持久化，不影响内存态）。
 */
export function saveUnreadSnapshot(counts: Partial<Record<DialogId, number>>): void {
  try {
    const valid = Object.fromEntries(
      Object.entries(counts).filter(([k, n]) => isDialogId(k) && typeof n === 'number' && n > 0),
    );
    if (Object.keys(valid).length === 0) {
      store?.removeItem(KEY);
      return;
    }
    store?.setItem(KEY, JSON.stringify(valid));
  } catch { /* ignore：不可用即无持久化 */ }
}

/** 测试面：直接覆写持久化键（MemoryStorage 桩配合；回归测试水合用） */
export function __setUnreadSnapshotRaw(raw: string): void {
  try { store?.setItem(KEY, raw); } catch { /* ignore */ }
}
