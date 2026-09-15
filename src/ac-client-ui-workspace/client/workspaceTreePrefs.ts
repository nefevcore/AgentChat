// ============================================================
// client/workspaceTreePrefs.ts —— 工作区树展开态持久化
//（刷新保持——与 composePrefs/lastContext 同款裁决归位 workspace 行）
//
// 记录什么：各树基准（key = 'c:<conversationId>' / 'a:<agentId>'
// / '' 全局——workspaceTreeStore.contextKey 同源）的展开目录路径
// 集合。树数据/滚动位置/activePath 仍是会话内瞬态（懒加载重取 +
// 滚动随渲染高度变化）——只有「展开哪些目录」是用户积累的手工
// 选择，值得跨刷新回放。
//
// 持久形态：localStorage 单键 agentchat.workspaceTreePrefs，
// { contexts: { [key]: string[] } }。写侧去抖（200ms）合帧——
// 连续展开/收起只落终值；pagehide 冲刷兜底（防去抖悬尾随页卸丢失）。
//
// 失效防御：目录更名/删除后旧路径不再命中树——展开集合里的幽灵
// 路径无害（只是渲染层不再出现），读取时对 string 数组逐项校验，
// 非 string 剔除；损坏/无 localStorage（jsdom/node 缺省）→ 空
// 态静默降级（行为同无记录）。
// ============================================================

/** 结构化 localStorage 面（jsdom/node 环境缺省 undefined——try/catch 兜底） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const store: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

const KEY = 'agentchat.workspaceTreePrefs';

/** 单基准展开路径条目上限（防异常会话（自动展开脚本等）无限膨胀写爆 quota） */
const MAX_PATHS_PER_CONTEXT = 200;
/** 全部基准条目上限（长站会话多基准积累护栏） */
const MAX_CONTEXTS = 50;

/** wire 形（持久形态） */
export interface WorkspaceTreePrefs {
  /** 各树基准的展开路径集合（数组持久，Set 运行时） */
  contexts: Record<string, string[]>;
}

function emptyPrefs(): WorkspaceTreePrefs {
  return { contexts: {} };
}

/** 读取某基准的展开集合（无记录/损坏/不可用 → 空 Set，行为同无记录） */
export function loadExpanded(key: string): Set<string> {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return new Set();
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ctx = v?.contexts;
    if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) return new Set();
    const arr = (ctx as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((p): p is string => typeof p === 'string').slice(0, MAX_PATHS_PER_CONTEXT));
  } catch (err) {
    console.warn('[tree-prefs] load 抛错（按空态处理）:', err);
    return new Set();
  }
}

/** 挂起写（去抖中待落盘的补丁；flush 时合并落盘） */
let pending: Map<string, string[]> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** pagehide 冲刷登记（模块级一次性；重复调用幂等） */
let pagehideHooked = false;

function hookPagehide() {
  if (pagehideHooked) return;
  pagehideHooked = true;
  try {
    globalThis.addEventListener?.('pagehide', () => flushExpanded());
  } catch { /* 无事件面（node）——无冲刷兜底 */ }
}

/** 合并写：某基准的展开集合全量替换（去抖 200ms 落盘；值变更即时冲刷） */
export function saveExpanded(key: string, paths: Iterable<string>): void {
  try {
    if (!pending) pending = new Map();
    pending.set(key, [...paths].slice(0, MAX_PATHS_PER_CONTEXT));
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flushExpanded(), 200);
    hookPagehide();
  } catch { /* ignore：不可用即无持久化 */ }
}

/** 立即落盘挂起补丁（去抖到期/pagehide 调用；无挂起 = no-op） */
export function flushExpanded(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending || pending.size === 0) return;
  const patch = pending;
  pending = null;
  try {
    const base = loadAll();
    const contexts: Record<string, string[]> = {};
    // 未被本批补丁触及的既有条目（保持序）在前，补丁键重排到尾——
    // 条目护栏裁旧留新（刚交互过的基准永不先被裁）
    for (const [k, v] of Object.entries(base.contexts)) {
      if (!patch.has(k) && v.length > 0) contexts[k] = v;
    }
    for (const [k, v] of patch) {
      if (v.length > 0) contexts[k] = v; // 空集合不入册（同下剔除语义）
    }
    const keys = Object.keys(contexts);
    if (keys.length > MAX_CONTEXTS) {
      for (const k of keys.slice(0, keys.length - MAX_CONTEXTS)) delete contexts[k];
    }
    store?.setItem(KEY, JSON.stringify({ contexts }));
  } catch { /* ignore */ }
}

function loadAll(): WorkspaceTreePrefs {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return emptyPrefs();
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ctx = v?.contexts;
    if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) return emptyPrefs();
    const out: Record<string, string[]> = {};
    for (const [k, arr] of Object.entries(ctx)) {
      if (Array.isArray(arr)) out[k] = arr.filter((p): p is string => typeof p === 'string');
    }
    return { contexts: out };
  } catch {
    return emptyPrefs();
  }
}
