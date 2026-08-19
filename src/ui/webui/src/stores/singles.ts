// ============================================================
// Singles Store —— 独立会话列表 + 激活态（P3）
//
// 激活语义与 groups 同模式：selectSingle → chatStore.setSingleContext
// （feed 分区 + WS 载荷带 session）+ 拉取会话历史；deselect 回到 pair。
// 列表数据来自 REST /api/singles（无 WS 推送，进入页面/创建/归档时刷新）。
// ============================================================

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { fetchSingles, createSingle, archiveSingle, type SingleSession } from '../core/api/endpoints/singles';
import { useChatStore } from './chat';
import { useFeedStore } from './feed';
import { logger } from '../utils/logger';

export const useSinglesStore = defineStore('singles', () => {
  const singles = ref<SingleSession[]>([]);
  const loaded = ref(false);
  /** 新建弹层 */
  const showCreate = ref(false);

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

  function openCreate() { showCreate.value = true; }
  function closeCreate() { showCreate.value = false; }

  /** 创建并立即进入会话 */
  async function create(payload: { agentId: string; model?: string | Record<string, unknown>; title?: string }): Promise<SingleSession> {
    const d = await createSingle(payload);
    await refresh();
    if (d.session) selectSingle(d.session.id);
    return d.session;
  }

  /** 激活独立会话：设置会话上下文。历史加载由 DialogView 的 single watch 统一触发
   * （与 group 模式一致：列表只切上下文，视图层负责加载） */
  function selectSingle(sessionId: string) {
    const session = singles.value.find(s => s.id === sessionId);
    if (!session || session.status === 'archived') return;
    useChatStore().setSingleContext(sessionId, session.agentId);
  }

  /** 回到 pair 会话（不清列表数据） */
  function deselectSingle() {
    useChatStore().clearSingleContext();
  }

  /** 归档（软删）：若正打开则先退出 */
  async function archive(sessionId: string): Promise<void> {
    await archiveSingle(sessionId);
    if (activeSingleId.value === sessionId) deselectSingle();
    await refresh();
  }

  /** Agent 名（列表展示用；经 agents store 解析） */
  function titleOf(s: SingleSession, agentName: (id: string) => string): string {
    return s.title || `${agentName(s.agentId)} · ${new Date(s.createdAt).toLocaleString()}`;
  }

  return {
    singles, loaded, activeSingles, activeSingleId, activeSingle,
    showCreate, refresh, openCreate, closeCreate,
    create, selectSingle, deselectSingle, archive, titleOf,
  };
});
