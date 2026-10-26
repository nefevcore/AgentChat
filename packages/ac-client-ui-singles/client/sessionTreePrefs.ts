// ============================================================
// ac-client-ui-singles/client/sessionTreePrefs.ts —— 主侧边栏
// 会话列表（SessionList）工作区分组折叠态持久化
//
// 记录什么：用户折叠的工作区分组 key 集合（workspace id +
// '__ungrouped__'）——「默认展开、记住折叠」语义的落地（此前
// collapsed 只是组件内 ref，切换视图/刷新即丢，注释里的「记住
// 用户折叠状态」从未兑现）。
//
// 持久形态：localStorage 单键 agentchat.sessionTreePrefs，值 =
// string[]（折叠 key 列表）。读侧逐项校验 string、护栏上限；
// 损坏/无 localStorage（jsdom/node 缺省）→ 空态静默降级。
//
// 失效防御：工作区删除后旧 key 不再命中列表——集合里的幽灵 key
// 无害（只是渲染层不再出现）；写侧全量替换，幽灵随下次交互自然
// 淘汰。与 composePrefs/workspaceTreePrefs 同款手法（storage 面
// import 时捕获；不引 DOM lib——本包进根 tsc 程序）。
// ============================================================

/** 结构化 localStorage 面（jsdom/node 环境缺省 undefined——try/catch 兜底） */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const store: StorageLike | undefined = (globalThis as { localStorage?: StorageLike }).localStorage;

const KEY = 'agentchat.sessionTreePrefs';

/** 折叠 key 条目上限（防异常膨胀写爆 quota） */
const MAX_COLLAPSED = 200;

/** 读取折叠集合（无记录/损坏/不可用 → 空 Set，行为同无记录） */
export function loadCollapsed(): Set<string> {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return new Set();
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return new Set();
    return new Set(v.filter((k): k is string => typeof k === 'string').slice(0, MAX_COLLAPSED));
  } catch {
    return new Set();
  }
}

/** 写回折叠集合（满集合全量替换；失败静默——不可用即无持久化） */
export function saveCollapsed(collapsed: Iterable<string>): void {
  try {
    store?.setItem(KEY, JSON.stringify([...collapsed].slice(0, MAX_COLLAPSED)));
  } catch { /* ignore：不可用即无持久化 */ }
}
