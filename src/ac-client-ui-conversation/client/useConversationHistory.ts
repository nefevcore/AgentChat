// ============================================================
// client/useConversationHistory.ts —— 会话历史装载编排
//（conversation-view-split-plan ③：自 ConversationView 整体迁入的历史
//  装载块——三条 load-more 路径 + 全部装载 watch。**全部踩坑注释逐字
//  随迁**（immediate 三连 / 取消守卫 / 8s 超时 / 群聊无限递归防护——它们
//  是行为规约的一部分，见 src/docs/conversation-view-split-plan.md §四）。
// ============================================================

import { ref, watch, nextTick, computed, type Ref } from 'vue';
import { groupDialog, pairDialog } from './feed.ts';
import { VIEWER_ID } from './viewer.ts';
import { traceSwitch } from './switchTrace.ts';
import { useChatStore } from './chatStore.ts';
import { useFeedStore } from './feedStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import type { ConversationViewProps, ConversationIdentity } from './useConversationIdentity.ts';

/** TranscriptList expose 面的结构化声明（.ts 不导 .vue 组件类型）
 *  ——组件实际定义：TranscriptList.vue defineExpose。
 *  可选性：fresh 开场（isSingleFresh）下不渲染，挂载时序晚于 watch
 *  immediate 首调 → transcript.value?. 可选链容错必须保持。 */
export interface TranscriptListHandle {
  scrollToBottom(forceGlide?: boolean): void;
  reset(): void;
  container(): HTMLElement | undefined;
}

export function useConversationHistory(opts: {
  props: ConversationViewProps;
  /** 身份派生层产物（useConversationIdentity） */
  identity: ConversationIdentity;
  /** TranscriptList 组件实例（expose 面 = TranscriptListHandle） */
  transcript: Ref<TranscriptListHandle | undefined>;
}) {
  const { props, identity, transcript } = opts;
  const chatStore = useChatStore();
  const feed = useFeedStore();
  const roster = useRosterCore();
  const { dialogId, rawMessages, feedDialog, isGroup, isSingle, isPair } = identity;

  // ── 历史加载（三路径：direct 续拉 / group 前插 / pair 前插）──
  const isLoadingMore = ref(false);

  /** direct：触发加载更多历史并保持滚动位置（新消息插入顶部，scrollTop 同步下移） */
  async function triggerLoadMore() {
    if (isGroup.value || isPair.value) return; // 群/pair 走前插路径
    if (isLoadingMore.value) return;
    if (!chatStore.hasMoreHistory || chatStore.loadingHistory) return;
    traceSwitch('load-more', `${dialogId.value}（内容不满一屏自动续拉 → 加载指示器再次出现）`);
    isLoadingMore.value = true;
    const container = transcript.value?.container();
    if (!container) { isLoadingMore.value = false; return; }
    const prevScrollTop = container.scrollTop;
    const prevScrollHeight = container.scrollHeight;
    // 身份守卫：await 期间切换会话（同一 DOM 容器复用）时，迟到恢复不得
    // 按新会话的内容计算滚动补偿（高度差会把无关变化当作"新插入历史"）
    const dialogAtStart = dialogId.value;

    chatStore.loadMoreHistory();
    await waitForHistoryLoaded();
    await nextTick();

    if (dialogId.value === dialogAtStart) {
      const addedHeight = container.scrollHeight - prevScrollHeight;
      container.scrollTop = prevScrollTop + addedHeight;
    }
    isLoadingMore.value = false;

    // 内容仍不足一屏且还有更多 → 继续续拉
    if (dialogId.value === dialogAtStart && chatStore.hasMoreHistory && container.scrollHeight <= container.clientHeight) {
      await nextTick();
      void triggerLoadMore();
    }
  }

  /** 等待历史加载完成（8s 超时兜底）。
   *  此前无超时：WS 断线期间在途 history.request 永无响应 → loadingHistory
   *  永远为 true → 本 Promise 永不 resolve → isLoadingMore 卡死、顶部 spinner
   *  不消失、后续 triggerLoadMore 全被守卫挡掉（"偶发卡死"根源之一）。 */
  function waitForHistoryLoaded(): Promise<void> {
    return new Promise((resolve) => {
      if (!chatStore.loadingHistory) { resolve(); return; }
      const stop = watch(() => chatStore.loadingHistory, (val) => {
        if (!val) { cleanup(); resolve(); }
      });
      const timer = setTimeout(() => { cleanup(); resolve(); }, 8000);
      function cleanup() {
        clearTimeout(timer);
        stop();
      }
    });
  }

  /** group：上翻加载更早历史（委托 feed 前插，保持滚动位置） */
  async function loadOlderGroupHistory() {
    if (!props.group || !dialogId.value || isLoadingMore.value) return;
    isLoadingMore.value = true;
    try {
      const container = transcript.value?.container();
      const prevHeight = container ? container.scrollHeight : 0;
      const older = await feed.loadOlderGroupHistory(dialogId.value, props.group.group_id);
      if (older && older.length > 0) {
        nextTick(() => {
          if (container) container.scrollTop = container.scrollHeight - prevHeight;
        });
      }
    } finally {
      isLoadingMore.value = false;
    }
  }

  /** pair：上翻加载更早历史（REST /api/history 前插，保持滚动位置——自
   *  PairDialogView 并入；feedDialog 三态守卫同款） */
  async function loadOlderPairHistory() {
    if (!isPair.value || !dialogId.value || isLoadingMore.value) return;
    if (feedDialog.value?.status === 'loading' || !feedDialog.value?.hasMore) return;
    isLoadingMore.value = true;
    try {
      const container = transcript.value?.container();
      const prevHeight = container ? container.scrollHeight : 0;
      const older = await feed.loadOlderPairHistory(dialogId.value, props.a!, props.b!);
      if (older && older.length > 0) {
        nextTick(() => {
          if (container) container.scrollTop = container.scrollHeight - prevHeight;
        });
      }
    } finally {
      isLoadingMore.value = false;
    }
  }

  /** 滚动到顶部阈值：按形态加载更早历史 */
  function onTopThreshold() {
    if (isGroup.value) {
      void loadOlderGroupHistory();
    } else if (isPair.value) {
      void loadOlderPairHistory();
    } else {
      void triggerLoadMore();
    }
  }

  // ════════════ 历史装载 watches（四形态）════════════

  /** pair：切换格子（或首挂）→ 加载该会话对历史 + 滚底（自 PairDialogView 并入） */
  watch(() => [props.a, props.b], async ([a, b], _old, onCleanup) => {
    if (!a || !b) return;
    transcript.value?.reset(); // 清掉滚动外壳闭包残留
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    await feed.loadPairHistory(pairDialog(a, b), a, b);
    if (cancelled) return;
    nextTick(() => transcript.value?.scrollToBottom());
  }, { immediate: true });

  /** group：切换群组 → 加载该群历史（实时 group.message 由 feed.ingest 统一处理） */
  watch(() => props.group?.group_id, (newId, oldId, onCleanup) => {
    if (newId && newId !== oldId) {
      // 取消守卫：快速 A→B 切群时，A 的迟到回调不得对 B 的视图滚底
      let cancelled = false;
      onCleanup(() => { cancelled = true; });
      feed.loadGroupHistory(groupDialog(newId), newId).then(() => {
        if (!cancelled) nextTick(() => transcript.value?.scrollToBottom());
      });
    }
  }, { immediate: true });

  /** 会话切换：重置滚动外壳闭包状态 + 滚动到底部（四形态同管线——
   *  useChatShell 的 isUserScrolledUp/lastScrollTop 是闭包状态，不重置会
   *  跨会话残留：新会话不足一屏时 scroll 事件不触发，残留的"用户上翻"
   *  标志会停掉自动滚底并悬浮"回到底部"按钮） */
  watch(dialogId, () => {
    traceSwitch('view-switch', `${dialogId.value}（DOM 更新前的 watch）`);
    transcript.value?.reset();
    transcript.value?.scrollToBottom();
    nextTick(() => {
      traceSwitch('dom-updated', `${dialogId.value} → ${rawMessages.value.length} 条消息上屏`);
    });
  });

  /** 切换 Agent（direct）：统一加载历史 + 滚动到底部。
   *  历史加载收敛于此（与 single 模式对齐）——此前分散在 AgentList/RunTracking/
   *  RunTrackingPanel/chat.ts 四处调用方，任何新导航入口漏调即"空白会话直到刷新"。
   *  保留的重复调用（矩阵入口的同 id 重入、chat.ts 恢复路径）由 feed 的
   *  requestId 时序守卫去重，不产生错误合并。
   *  immediate（2026-09-12 前端反馈）：视角是 keyed 选举席——single/group ↔
   *  talk 互切时本视图整体重挂载，挂载时 activeAgentId 早已就位（早在
   *  AgentList 点击时刻赋值）。缺 immediate 时挂载首调不触发，direct 分区
   *  停留在 showInbound 实时推入的入站消息——「收到主动消息点进会话只见
   *  该条、历史要刷新才回来」的根源（single watch 同款已有 immediate）。
   *  重复 loadHistory 由 feed 的 requestId 时序守卫去重，无重复合并风险。 */
  const isInitialHistoryLoad = ref(true);
  watch(() => roster.activeAgentId.value, (id) => {
    if (isGroup.value || isSingle.value || isPair.value) return;
    traceSwitch('view-watch', `activeAgentId=${id || '(空)'}`);
    isInitialHistoryLoad.value = true;
    if (id) chatStore.loadHistory(VIEWER_ID.value, id);
    transcript.value?.scrollToBottom();
  }, { immediate: true });

  /** single 切换：加载该会话历史（feed 分区 singleDialog；WS 流事件按 dialogId 自动路由） */
  watch(() => props.single?.id, (newId, oldId) => {
    if (!newId || newId === oldId) return;
    traceSwitch('view-watch', `single=${newId.slice(-8)}`);
    isInitialHistoryLoad.value = true;
    chatStore.loadHistory(VIEWER_ID.value, props.single!.agentId, newId);
    transcript.value?.scrollToBottom();
  }, { immediate: true });

  // 每次历史加载完成：首次加载 → 滚动到底部；续拉 → 保持位置。
  // 群聊不走此 direct 自动续拉逻辑（否则空群聊 hasMore=true + 内容不足一屏会无限递归
  // triggerLoadMore → 页面卡死）；群聊上翻由 loadOlderGroupHistory 按滚动触发。
  watch(() => chatStore.loadingHistory, (loading, wasLoading) => {
    if (isGroup.value || isPair.value || loading || !wasLoading) return;
    traceSwitch('loading(false)', `${dialogId.value} 首屏=${isInitialHistoryLoad.value} hasMore=${chatStore.hasMoreHistory}`);
    if (isInitialHistoryLoad.value) {
      isInitialHistoryLoad.value = false;
      nextTick(() => transcript.value?.scrollToBottom());
    }
    if (chatStore.hasMoreHistory) {
      nextTick(() => {
        const el = transcript.value?.container();
        if (el && el.scrollHeight <= el.clientHeight && !isLoadingMore.value) void triggerLoadMore();
      });
    }
  });
  // loading=true 的时刻（加载指示器出现的时刻；click→此点 = 首帧未更新的时长）
  watch(() => chatStore.loadingHistory, (loading) => {
    if (loading && !isGroup.value && !isPair.value) traceSwitch('loading(true)', `${dialogId.value}（加载指示器应当出现）`);
  });

  /** TranscriptList 显示态（形态各异项收拢） */
  const topLoading = computed(() => isLoadingMore.value || (isPair.value ? feedDialog.value?.status === 'loading' : chatStore.loadingHistory));
  const firstLoadPending = computed(() => (isPair.value ? feedDialog.value?.status === 'loading' : chatStore.loadingHistory));

  return {
    isLoadingMore,
    onTopThreshold,
    topLoading,
    firstLoadPending,
  };
}

export type ConversationHistory = ReturnType<typeof useConversationHistory>;