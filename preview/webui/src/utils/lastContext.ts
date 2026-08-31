// ============================================================
// utils/lastContext.ts —— 上次会话上下文持久化（刷新恢复）
//
// 统一记录用户最后所在的会话上下文（agent pair / group / single
// 三选一，最后写入者胜），刷新后据此恢复列表选中与对话视图。
// 替代旧散键 agentchat.lastAgent / agentchat.lastGroup（读取时
// 自动迁移）。
// ============================================================

type LastContextKind = 'agent' | 'group' | 'single';

interface LastContext {
  kind: LastContextKind;
  id: string;
}

const KEY = 'agentchat.lastContext';
const LEGACY_AGENT_KEY = 'agentchat.lastAgent';
const LEGACY_GROUP_KEY = 'agentchat.lastGroup';

/** 读取上次上下文（新键优先；缺省迁移旧键 agent→group 顺序） */
export function loadLastContext(): LastContext | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if ((v?.kind === 'agent' || v?.kind === 'group' || v?.kind === 'single') && typeof v.id === 'string' && v.id) {
        return v as LastContext;
      }
    }
    // 旧键迁移（一次性写入新键；保留旧键不清除，避免降级回旧版本丢状态）
    const legacyAgent = localStorage.getItem(LEGACY_AGENT_KEY);
    if (legacyAgent) {
      const ctx: LastContext = { kind: 'agent', id: legacyAgent };
      saveLastContext(ctx);
      return ctx;
    }
    const legacyGroup = localStorage.getItem(LEGACY_GROUP_KEY);
    if (legacyGroup) {
      const ctx: LastContext = { kind: 'group', id: legacyGroup };
      saveLastContext(ctx);
      return ctx;
    }
  } catch { /* 损坏/不可用：无恢复 */ }
  return null;
}

export function saveLastContext(ctx: LastContext): void {
  try { localStorage.setItem(KEY, JSON.stringify(ctx)); } catch { /* ignore */ }
}

/** 仅当当前记录的 kind 匹配时清除（避免跨类型误清：如选会话时触发的 deselectGroup） */
export function clearLastContextIf(kind: LastContextKind): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v?.kind === kind) localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
