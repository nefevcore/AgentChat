// ============================================================
// Singles Store —— 独立会话列表 + 激活态（P3/P4）
//
// 激活语义与 groups 同模式：selectSingle → chatStore.setSingleContext
// （feed 分区 + WS 载荷带 session）+ 拉取会话历史；deselect 回到 pair。
// 列表数据来自 REST /api/singles；WS singles.updated（自动标题/设置变更）
// 触发刷新。
//
// 快速创建（P4）：+ 按钮直接生成**空会话**（无 Agent），进入后输入栏
// 下拉选择 Agent / 模型（updateSession PATCH 即时生效）再发送。
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { fetchSingles, createSingle, updateSingle, archiveSingle, deleteSingle, type SingleSession } from '../core/api/endpoints/singles';
import { useChatStore } from './chat';
import { useFeedStore } from './feed';
import { useAgentStore } from './agents';
import { registerEventHandler } from '../core/registry/eventHandlers';
import { WS_EVENT } from '../core/events/contract';
import { logger } from '../utils/logger';
import { saveLastContext, clearLastContextIf, loadLastContext } from '../utils/lastContext';

export const useSinglesStore = defineStore('singles', () => {
  const singles = ref<SingleSession[]>([]);
  const loaded = ref(false);

  const activeSingleId = computed(() => useFeedStore().activeSingleId);
  const activeSingle = computed(() =>
    activeSingleId.value ? singles.value.find(s => s.id === activeSingleId.value) ?? null : null,
  );
  /** 列表只显示未归档 */
  const activeSingles = computed(() => singles.value.filter(s => s.status === 'active'));

  async function refresh(): Promise<void> {
    try {
      const d = await fetchSingles();
      singles.value = d.singles ?? [];
      loaded.value = true;
    } catch (err: any) {
      logger.warn('[SinglesStore] 拉取独立会话列表失败:', err?.message ?? String(err));
    }
  }

  /** 快速创建空会话（P4：无 Agent；已有空会话时复用，避免堆积空白条目） */
  async function createQuick(): Promise<SingleSession | null> {
    return create({ reuse: true });
  }

  /** 创建并立即进入会话 */
  async function create(payload: { agentId?: string; model?: string | Record<string, unknown>; title?: string; workspaceId?: string; reuse?: boolean }): Promise<SingleSession> {
    const d = await createSingle(payload);
    await refresh();
    if (d.session) selectSingle(d.session.id);
    return d.session;
  }

  /** 激活独立会话：设置会话上下文。历史加载由 DialogView 的 single watch 统一触发
   * （与 group 模式一致：列表只切上下文，视图层负责加载）。
   * agentId 空 = 默认预设（后端路由目标；消息身份与其对齐） */
  function selectSingle(sessionId: string) {
    const session = singles.value.find(s => s.id === sessionId);
    if (!session || session.status === 'archived') return;
    useChatStore().setSingleContext(sessionId, session.agentId || useAgentStore().defaultPresetId);
    saveLastContext({ kind: 'single', id: sessionId });
  }

  /** 回到 pair 会话（不清列表数据） */
  function deselectSingle() {
    useChatStore().clearSingleContext();
    clearLastContextIf('single');
  }

  /** 刷新恢复：上次上下文是 single 时恢复选中（会话已删/已归档则清掉过期记录） */
  function restoreLastSingle(): string | null {
    const ctx = loadLastContext();
    if (ctx?.kind !== 'single') return null;
    const session = singles.value.find(s => s.id === ctx.id);
    if (!session || session.status !== 'active') {
      clearLastContextIf('single');
      return null;
    }
    selectSingle(ctx.id);
    return ctx.id;
  }

  /**
   * 更新会话设置（输入栏内联调整：换 Agent（''=清空待选；已有消息时后端 409 禁改）/
   * 换模型覆盖（null=清除）/ 挂工作区（''=移入未分组））。
   * 换 Agent 时同步刷新会话上下文（feed 消息身份映射 + 后续投递目标）。
   */
  async function updateSession(sessionId: string, payload: { agentId?: string; model?: string | Record<string, unknown> | null; workspaceId?: string }): Promise<SingleSession | null> {
    const d = await updateSingle(sessionId, payload);
    await refresh();
    // 活跃会话换 Agent → 重建上下文（agentId 变化影响消息身份与投递目标；''=默认预设）
    if (payload.agentId !== undefined && activeSingleId.value === sessionId) {
      useChatStore().setSingleContext(sessionId, payload.agentId || useAgentStore().defaultPresetId);
    }
    return d.session ?? null;
  }

  /** 归档（软删）：若正打开则先退出 */
  async function archive(sessionId: string): Promise<void> {
    await archiveSingle(sessionId);
    if (activeSingleId.value === sessionId) deselectSingle();
    await refresh();
  }

  /** 删除（硬删：元数据+消息）：若正打开则先退出 */
  async function remove(sessionId: string): Promise<void> {
    await deleteSingle(sessionId);
    if (activeSingleId.value === sessionId) deselectSingle();
    await refresh();
  }

  /** Agent 名（列表展示用；经 agents store 解析（含预设目录）；空 = 默认预设） */
  function titleOf(s: SingleSession, agentName: (id: string) => string): string {
    if (!s.agentId) return s.title || '新会话';
    return s.title || `${agentName(s.agentId)} · ${new Date(s.createdAt).toLocaleString()}`;
  }

  // ── WS singles.updated（自动标题生成/设置变更）→ 刷新列表（标题即时上屏）──
  registerEventHandler(WS_EVENT.singlesUpdated, () => { void refresh(); });

  return {
    singles, loaded, activeSingles, activeSingleId, activeSingle,
    refresh, createQuick, create,
    selectSingle, deselectSingle, restoreLastSingle, updateSession, archive, remove, titleOf,
  };
});
