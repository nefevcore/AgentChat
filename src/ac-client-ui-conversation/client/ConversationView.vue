<script setup lang="ts">
// ============================================================
// client/ConversationView.vue —— 统一会话视图内核（四形态单一组件）
//
// 会话区重构产物（原 DialogView.vue 更名扩容）：
//   · group prop 非空 → 群聊（成员抽屉已迁 aux-sidebar 选区 / 改名随群域）
//   · single prop 非空 → 独立会话（消息渲染/direct 输入复用）
//   · a/b + readonly → 只读会话对（pair 视角：仅阅读消息，禁止编辑类
//     操作——无输入框/无 dock/无仪表/轮内动作关闭；原 PairDialogView
//     并入，消息渲染链经 TranscriptList/useTurnDisplayItems 单源共享）
//   · 皆空 → direct 会话（激活 Agent 对桶）
// 消息区整块住 TranscriptList（B 路线抽取）；滚动外壳随其在本地，
// 本视图经 ref 拿 scrollToBottom/reset/container。
// 头部动作区开 conversation:header-widget 席位（list，order 序）：
// jobs chip（jobs 行）/ Token 仪表·System Prompt 预览（本行出厂）/
// Agent·single 动作（agents/singles 行）经贡献自取 ownerProps；内核只留
// 思维链开关与归档反馈锚。System Prompt 预览弹窗走 overlay 席位
//（conversation 出厂贡献，开关态住 ui store）。
// ============================================================

import { ref, watch, nextTick, computed, inject, onUnmounted, type Ref } from 'vue';
import { Avatar, Icon, FeedbackNotice, ThinkingIcon } from '@agentchat/webui-kit';
import type { GroupInfo, ChatMessage, Turn } from './types.ts';
import { VIEWER_ID } from './viewer.ts';
import type { SingleSession } from 'ac-client-ui-singles/client';
import { useChatStore } from './chatStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useClientContext } from 'ac-client-runtime';
import { useFeedStore } from './feedStore.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { directDialog, groupDialog, singleDialog, pairDialog, bucketKey } from './feed.ts';
import { traceSwitch } from './switchTrace.ts';
import { useQueueSeat } from './useQueuedMessages.ts';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';
import TranscriptList from './TranscriptList.vue';
import ComposerDock from './ComposerDock.vue';
import ChatInput from './ChatInput.vue';
import { useTurnDisplayItems } from './useTurnDisplayItems.ts';

const props = defineProps<{
  group: GroupInfo | null;
  /** 独立会话（非空 = single 视角，消息渲染/direct 输入复用） */
  single?: SingleSession | null;
  /** pair 视角端点（runview 跨包 async 引用注册；两端点都非 viewer） */
  a?: string | null;
  b?: string | null;
  /** 只读形态（pair 视角传入：仅阅读消息，禁止编辑类操作——输入/dock/仪表/轮内动作全关） */
  readonly?: boolean;
}>();
const chatStore = useChatStore();
const roster = useRosterCore();
// rpc 契约面（宿主 'rpc' 服务——wireRpc 薄壳；群发/连接态经此）
const rpc = useClientContext()?.rpc ?? null;
// 连接态初值取现态（M27 S3-1b 回归修复）：行 client 经 boot graph 异步
// 装载后，WS 常在视图挂载前已开——onOpen 只在「下一次」开时触发，
// 纯事件初值 false 会让连接条永久误显（注册顺序竞态）。
// 桩缺省（connected 未提供）按已连接处理（离线桩不误显断连条）
const wireStoreConnected = ref(rpc?.connected?.() ?? true);
rpc?.onOpen?.(() => { wireStoreConnected.value = true; });
rpc?.onClose?.(() => { wireStoreConnected.value = false; });
const feed = useFeedStore();
const ui = useUiStore();

/** 注入壳提供的移动端抽屉开合方法 */
const toggleDrawer = inject<() => void>('toggleDrawer', () => {});
/** 消息左右对齐基准（用户消息靠右；pair = viewer：两端非 user 全左气泡） */
const settingsAgentId = inject<Ref<string>>('settingsAgentId', ref(VIEWER_ID.value));

const isGroup = computed(() => !!props.group);
const isSingle = computed(() => !!props.single);
/** pair 只读形态（a/b 端点 + readonly——runview 注册时恒同真） */
const isPair = computed(() => !!(props.a && props.b));

/** 消息区 ref（TranscriptList 持滚动外壳，本视图经 expose 面驱动） */
const transcript = ref<InstanceType<typeof TranscriptList>>();

const dialogId = computed(() => {
  if (props.single) return singleDialog(props.single.id);
  if (props.group) return groupDialog(props.group.group_id);
  if (isPair.value) return pairDialog(props.a!, props.b!);
  const a = roster.activeAgentId.value;
  return a ? directDialog(a) : null;
});

/** rawMessages 来自统一信息流（单一真相源） */
const rawMessages = computed<ChatMessage[]>(() => (dialogId.value ? feed.getRaw(dialogId.value) : []));
const feedDialog = computed(() => (dialogId.value ? feed.getDialog(dialogId.value) : undefined));

// ── 头部目标/标题 ──
/** single 承载 Agent（元数据 agentId 空 = 默认预设——与 singles store
 *  selectSingle 同款补 defaultPresetId；空串会令后端把 sid 当 viewer 估算） */
const singleAgentId = computed(() =>
  props.single ? (props.single.agentId || roster.defaultPresetId.value) : null);
/** 群主（记忆属主）——群形态的头部目标 Agent：Token 仪表/系统提示词预览
 *  以群主视角分析（未配群主回落首成员；无成员 = null 不出仪表） */
const groupOwnerAgentId = computed(() => {
  if (!props.group) return null;
  return props.group.memory_owner || props.group.participants[0] || null;
});
/** 头部目标 Agent（single 场景 = 会话承载 Agent；群 = 群主；否则当前激活 Agent） */
const headerAgentId = computed(() =>
  singleAgentId.value ?? (isGroup.value ? groupOwnerAgentId.value : roster.activeAgentId.value));

const activeAgentName = computed(() => {
  const id = headerAgentId.value;
  if (!id) return '';
  // getAgentName 含预设目录解析（预设 Agent 不在 agents 列表）
  return roster.getAgentName(id) || id;
});
const title = computed(() => {
  if (props.single) {
    if (!props.single.agentId) return props.single.title || '新会话';
    return props.single.title
      || `${activeAgentName.value || props.single.agentId} · 独立会话`;
  }
  if (props.group) return props.group.name;
  return roster.activeAgentId.value ? activeAgentName.value : '选择一个 Agent 开始对话';
});

/** pair 端点展示信息（system 端点特殊标签；头像/名称经名册解析） */
function endpointOf(id: string) {
  const isSystem = id === 'system';
  return {
    id,
    name: isSystem ? 'system（系统触发）' : (roster.getAgentName(id) || id),
    avatar: isSystem ? null : roster.getAgentAvatar(id),
  };
}
const epA = computed(() => endpointOf(props.a || ''));
const epB = computed(() => endpointOf(props.b || ''));

/** 会话头任务清单的会话键（发起会话过滤口径）：single sid / 群 gid /
 *  1v1 对桶键——与任务登记侧（call.conversationId）同词表；pair 无归属 → null */
const jobsConversationId = computed(() => {
  if (isPair.value) return null;
  if (props.single) return props.single.id;
  if (props.group) return props.group.group_id;
  const a = roster.activeAgentId.value;
  return a ? bucketKey(VIEWER_ID.value, a) : null;
});

/** 头部席位 owner 上下文（D16-③：贡献按 form 自取自gate）——群形态
 *  agentId = 群主（memoryOwner 回落首成员），conversationId = gid：
 *  Token 仪表/系统提示词预览按群主视角请求（session/tokens 群分支 +
 *  agents/system-prompt 带 conversationId） */
const headerWidgetData = computed(() => ({
  form: (isPair.value ? 'pair' : props.single ? 'single' : props.group ? 'group' : 'direct') as 'direct' | 'group' | 'single' | 'pair',
  agentId: isPair.value ? null : headerAgentId.value,
  conversationId: jobsConversationId.value,
  single: props.single ?? null,
}));

// ── next-turn 排队面（DSH queue 姿势；per-conversation 核心态住 store
//    座位实例轴——conversation:dock-widget × 'queue' × convId，
//    QueueDockHost 贡献与本视图同轴同实例〔useQueueSeat 并源接线〕；
//    本视图仅消费计数/整队列插话〔ChatInput 接线〕，行级动作在贡献
//    容器内编排 ──
// agentId 兜底与 headerAgentId 同规（singleAgentId 同款）：single 元数据
// agentId 空 = 默认预设承载——直接回落 activeAgentId 在 single 视角下
// 恒 null → 座位 store.agentId 恒 null → 行级 remove/steer 的 RPC 参数
// 拼不齐而静默 no-op（「排队消息显示得出、删不掉」根因）；补默认预设
// 兜底后行级动作恢复寻址。
const dockAgentId = computed(() =>
  props.single ? (props.single.agentId || roster.defaultPresetId.value) : roster.activeAgentId.value || null);
const dockConversationId = computed(() =>
  props.single ? props.single.id
    : (roster.activeAgentId.value ? bucketKey(VIEWER_ID.value, roster.activeAgentId.value) : null));
const queued = useQueueSeat(dockConversationId, dockAgentId);
const queuedItems = computed(() => queued.value?.items.value ?? []);

/** 整队列插话（DSH 手势：空草稿 + Cmd/Ctrl+Enter → FIFO 全部插话进运行中轮次） */
async function steerAllQueued() {
  if (!chatStore.contextBusy || !queued.value) return;
  for (;;) {
    const first = queued.value.items.value[0];
    if (!first) break;
    const outcome = await queued.value.steer(first.id);
    if (outcome !== 'steered') break; // 窗口已关/条目失效：停止（不报失败）
    chatStore.appendOwnSteered(first.preview);
  }
}

// ── 发送（group 路径；direct/single 走 ChatInput 默认 store.sendMessage）──
const groupTurnInProgress = ref(false);

function sendGroupMessage(content: string, files?: import('./types.ts').FileAttachment[]) {
  if (!props.group || (!content.trim() && !files?.length) || !rpc) return;
  groupTurnInProgress.value = true;
  transcript.value?.scrollToBottom();
  // 群聊附件（M4）：文本行合成 + 图片引用旁挂（与直答路径同构——
  // chat store 的 composeContent/imageAttachmentsOf 单源复用）
  const composed = chatStore.composeContent(content, files);
  const attachments = chatStore.imageAttachmentsOf(files);
  // Port B：group/send 受理（rpc result）即解锁；失败同样解锁（10s 兜底保留）
  void rpc.call('group/send', {
    groupId: props.group.group_id,
    from: VIEWER_ID.value,
    content: composed,
    ...(attachments ? { attachments } : {}),
  })
    .then(() => resetGroupTurn())
    .catch(() => resetGroupTurn());
  // 兜底：投递确认/异常未及时到达时，10s 后也解除发送锁（Agent 回复本身经 group/message-posted 事件异步送达）
  if (groupSendTimer) clearTimeout(groupSendTimer);
  groupSendTimer = setTimeout(() => { groupTurnInProgress.value = false; }, 10_000);
}

let groupSendTimer: ReturnType<typeof setTimeout> | null = null;
function resetGroupTurn(groupId?: string) {
  if (groupId && props.group?.group_id !== groupId) return;
  groupTurnInProgress.value = false;
  if (groupSendTimer) { clearTimeout(groupSendTimer); groupSendTimer = null; }
}
onUnmounted(() => {
  // 发送锁兜底定时器清理（切视角卸载后仍会触发并操作已卸载实例）
  if (groupSendTimer) { clearTimeout(groupSendTimer); groupSendTimer = null; }
});

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

// ── 渲染模型（useTurnDisplayItems 单源管线——B 路线抽取）──
const turns = computed<Turn[]>(() => (dialogId.value ? feed.getTurns(dialogId.value).value : []));
const turnDisplayItems = useTurnDisplayItems(turns);

const streamingTailLen = computed(() => {
  const msgs = rawMessages.value;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'agent' && m.isStreaming) {
      return (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0) + (m.thinking?.length ?? 0);
    }
  }
  return 0;
});

/** TranscriptList 显示态（形态各异项收拢） */
const topLoading = computed(() => isLoadingMore.value || (isPair.value ? feedDialog.value?.status === 'loading' : chatStore.loadingHistory));
const firstLoadPending = computed(() => (isPair.value ? feedDialog.value?.status === 'loading' : chatStore.loadingHistory));
const emptyText = computed(() => {
  if (isPair.value) return '这两个对象之间暂无会话记录';
  return isGroup.value ? '群聊开始 — 发送第一条消息吧' : '开始对话 — 发送第一条消息吧';
});
const showTurnActions = computed(() => !isGroup.value && !isPair.value);

/** 文件预览（全局单例：stores/ui.ts）。context 三来源（M32 工作区推导）：
 *  payload 显式（消息链透传——说话者 Agent + 所在会话键）> 视图形态
 *  （single = 会话 id；pair = 任一端点作 fallback）> 激活 Agent。 */
function handlePreviewFile(payload: string | { filePath: string; agentId?: string; conversationId?: string }) {
  const fallbackAgent = isPair.value
    ? (props.a || props.b || '')
    : (roster.activeAgentId.value || '');
  const fallbackConv = props.single
    ? props.single.id
    : (roster.activeAgentId.value ? bucketKey(VIEWER_ID.value, roster.activeAgentId.value) : '');
  if (typeof payload === 'string') {
    ui.openPreview(payload, fallbackAgent, fallbackConv);
  } else {
    ui.openPreview(
      payload.filePath,
      payload.agentId || fallbackAgent,
      payload.conversationId || fallbackConv,
    );
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
</script>

<template>
  <div v-if="dialogId" class="chat-view">
    <!-- ═══ 头部（pair 形态：返回 + 双端点；其余：标题 + 动作区）═══ -->
    <div class="chat-header">
      <template v-if="isPair">
        <button class="back-btn" title="返回会话" @click="ui.closePairView()">
          <Icon name="arrow-left" :size="20" />
        </button>
        <div class="header-info">
          <div class="pair-title">
            <div class="pair-avatars">
              <Avatar v-if="epA.avatar" :src="epA.avatar" :name="epA.name" :size="26" />
              <span v-else class="ep-ic"><Icon name="zap" :size="13" /></span>
              <span class="pair-x"><Icon name="x" :size="9" /></span>
              <Avatar v-if="epB.avatar" :src="epB.avatar" :name="epB.name" :size="26" />
              <span v-else class="ep-ic"><Icon name="zap" :size="13" /></span>
            </div>
            <span class="agent-label">{{ epA.name }} × {{ epB.name }}</span>
            <span class="pair-sub">只读 · 双方视角</span>
          </div>
        </div>
      </template>

      <template v-else>
        <button v-if="!isGroup" class="hamburger-btn" @click="toggleDrawer" title="菜单">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
        </button>
        <div class="header-info">
          <span class="agent-label">{{ title }}</span>
        </div>
        <div class="header-actions">
          <!-- 思维链显示开关（全局 switch）：隐藏后思考文本、工具卡片与折叠栏
               整体不渲染，消息区仅显示正文回复。图标内嵌滑块（随开合滑动，
               关 = 灰/开 = 主色）——图标不再外置，压缩按钮整体宽度 -->
          <button
            class="thinking-switch"
            :class="{ on: ui.showThinking }"
            role="switch"
            :aria-checked="ui.showThinking"
            :title="ui.showThinking ? '思维链：显示中 · 点击隐藏（思考与工具轨迹）' : '思维链：已隐藏 · 点击显示'"
            @click="ui.setShowThinking(!ui.showThinking)"
          >
            <span class="thinking-switch-track"><span class="thinking-switch-knob"><ThinkingIcon :size="12" class="thinking-switch-icon" /></span></span>
          </button>

          <!-- 头部动作席位（list，order 序）：jobs chip（jobs 行 order 10）/
               Token 仪表（本行 order 20）/ System Prompt 预览（本行 order 25）/
               Agent·single 动作（agents·singles
               行 order 30）——贡献按 ownerProps.form 自取自gate，群/pair 形态
               全部自隐 -->
          <SlotOutlet name="conversation:header-widget" :data="headerWidgetData" />

          <!-- 归档/忙碌反馈 chip 的悬挂锚（弹层关闭时反馈仍需可见，故 wrap
               保留为零宽锚点；single 压缩反馈同样经此悬挂） -->
          <div v-if="!isGroup" class="compress-wrap">
            <transition name="fade">
              <!-- 反馈语义控件：tone 派生图标/配色（替代文案内嵌 emoji 前缀的旧形态） -->
              <FeedbackNotice
                v-if="chatStore.compressFeedback"
                class="compress-feedback"
                variant="chip"
                :text="chatStore.compressFeedback"
                :tone="chatStore.compressTone"
              />
            </transition>
            <transition name="fade">
              <FeedbackNotice
                v-if="chatStore.busyFeedback"
                class="compress-feedback"
                variant="chip"
                :text="chatStore.busyFeedback"
                :tone="chatStore.busyTone"
              />
            </transition>
            <transition name="fade">
              <!-- 归档整理进行中（任意触发源：手工/阈值/夜间批量）——机制 run
                   流式隐藏，此状态条 + 输入框占位是对话面唯一感知。
                   busy tone = loader 旋转 + primary 色（进行中语义，非灰色） -->
              <FeedbackNotice
                v-if="chatStore.archivePending && !chatStore.compressFeedback && !chatStore.busyFeedback"
                class="compress-feedback"
                variant="chip"
                text="正在归档整理记忆…"
                tone="busy"
              />
            </transition>
          </div>
        </div>
      </template>
    </div>

    <div v-if="!isGroup && !isPair && !wireStoreConnected" class="connection-status">
      <span>[WARN] 连接已断开，正在重连...</span>
    </div>

    <div class="chat-body">
      <div class="chat-main">
        <TranscriptList
          ref="transcript"
          :items="turnDisplayItems"
          :message-count="rawMessages.length"
          :streaming-tail-len="streamingTailLen"
          :on-top-threshold="onTopThreshold"
          :loading="topLoading"
          :first-load-pending="firstLoadPending"
          :empty-text="emptyText"
          :show-actions="showTurnActions"
          :settings-agent-id="settingsAgentId"
          :conversation-id="jobsConversationId ?? undefined"
          @preview-file="handlePreviewFile"
          @regenerate="chatStore.regenerateMessage"
          @delete-message="chatStore.deleteMessage"
          @edit="(msgId: any, newContent: any) => chatStore.editMessage(msgId, newContent)"
        />

        <!-- 任务 dock 列（composer 上方；群视角隐藏——多成员无单一归属桶；
             pair 只读无 composer/dock）。数据/刷新各卡自理 -->
        <ComposerDock
          v-if="!isGroup && !isPair"
          :agent-id="dockAgentId"
          :conversation-id="dockConversationId"
        />

        <!-- 输入区（单实例条件接线：group = RPC 群发路径；direct/single =
             store.sendMessage 默认路径 + 排队手势；pair 只读无输入） -->
        <ChatInput
          v-if="!isPair"
          :disabled="isGroup && groupTurnInProgress"
          :placeholder="isGroup ? (groupTurnInProgress ? 'Agent 回复中...' : '输入消息发送到群聊...') : undefined"
          :on-send="isGroup ? sendGroupMessage : undefined"
          :single="isGroup ? null : (props.single ?? null)"
          :queued-count="isGroup ? 0 : queuedItems.length"
          :on-steer-all-queued="isGroup ? undefined : steerAllQueued"
        />
      </div>
      <!-- 群视角右侧抽屉已迁 aux-sidebar 选区（ui-group 经 aside 区域贡献） -->
    </div>
  </div>

  <!-- 无对话（direct 未选中 / 无群组）空态 -->
  <div v-else class="chat-view empty-chat">
    <div class="empty-state">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.15">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <p>{{ isGroup ? '选择一个群组开始聊天' : '选择一个 Agent 开始对话' }}</p>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--color-bg-page);
}
.empty-chat { align-items: center; justify-content: center; color: var(--color-text-muted); }
.empty-state { text-align: center; padding: 40px; }
.empty-state svg { margin-bottom: 12px; }
.empty-state p { font-size: 15px; }

.chat-header {
  display: flex; align-items: center; gap: 10px;
  height: var(--layout-header-height); padding: 0 16px;
  border-bottom: 1px solid var(--color-border-secondary);
  background: var(--color-bg-page); flex-shrink: 0;
  backdrop-filter: blur(8px); z-index: 100;
}
.header-info { flex: 1; min-width: 0; }
/* 单行截断：主区被辅栏/主栏压缩时长标题（+ 头部 widget 挤压）不得换行
   撑破 48px 头部；pair 形态双端点名同理（.pair-title 已 min-width:0） */
.agent-label { font-size: 15px; font-weight: 600; color: var(--color-text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 汉堡菜单按钮：默认隐藏，窄屏显示 */
.hamburger-btn {
  display: none; background: none; border: none; cursor: pointer;
  color: var(--color-text-secondary); padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.hamburger-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }

.header-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; align-self: stretch; }

/* ── 思维链显示开关（图标内嵌滑块的 pill switch；全局生效，localStorage 持久化）── */
.thinking-switch {
  display: flex; align-items: center;
  background: none; border: none; cursor: pointer; flex-shrink: 0;
  color: var(--color-text-secondary); padding: 6px 8px; border-radius: var(--radius-sm);
  transition: color 0.15s;
}
.thinking-switch:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.thinking-switch-track {
  position: relative; width: 32px; height: 18px; flex-shrink: 0;
  border-radius: var(--r-full, 999px);
  background: var(--color-border-primary, #cfd3da);
  transition: background 0.2s ease;
}
.thinking-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  color: var(--color-text-tertiary, #a8abb2);
  transition: transform 0.2s ease, color 0.2s ease;
}
/* 内嵌图标：关 = 灰（未显示思维链）/ 开 = 主色白底反色（图标以主色呈现在白滑块上） */
.thinking-switch-icon { display: block; line-height: 0; }
.thinking-switch.on { color: var(--color-primary, #6366f1); }
.thinking-switch.on .thinking-switch-track { background: var(--color-primary, #6366f1); }
.thinking-switch.on .thinking-switch-knob { transform: translateX(14px); color: var(--color-primary, #6366f1); }

.chat-body { flex: 1; display: flex; overflow: hidden; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.connection-status { text-align: center; padding: 6px; font-size: 12px; color: var(--color-warning); background: var(--color-bg-surface); flex-shrink: 0; }

/* ── pair 头部（返回按钮 + 双端点标题——自 PairDialogView 并入）── */
.back-btn {
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer;
  color: var(--color-text-secondary); padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.back-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }
.pair-title{display:flex;align-items:center;gap:10px;min-width:0}
.pair-avatars{display:flex;align-items:center;gap:4px;flex-shrink:0}
.pair-x{display:inline-flex;align-items:center;color:var(--color-text-tertiary,#a8abb2)}
.pair-sub{font-size:11px;color:var(--color-text-tertiary,#a8abb2);white-space:nowrap;margin-left:4px}
.ep-ic{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;color:#f59e0b;background:rgba(245,158,11,.15);flex-shrink:0}

/* ── 归档反馈锚（归档入口住 Token 仪表弹层——TokenGauge 贡献）──
   wrap 拉满头部高（align-self: stretch，header-actions 同步拉满作参照）：
   按钮迁出后 wrap 只剩绝对定位 chip、内容高度为 0——top:calc(100%+…) 从
   头部垂直中心起算，chip 上浮进头部、盖住仪表下半区。拉满后 100% = 头部
   底缘，chip 恒挂头部下方。 */
.compress-wrap { position: relative; display: flex; align-items: center; align-self: stretch; }
/* 归档/忙碌反馈 chip：悬挂于头部底缘下方 10px、右缘对齐 Token 仪表右缘
   （环的正下方）——与仪表/头部控件留足间隔不阻挡；pointer-events:none
   不拦点击。Token 弹层打开时（z-60）chip 沉其下，弹层自身已带整理态展示 */
.compress-feedback { position: absolute; top: calc(100% + 10px); right: 0; pointer-events: none; white-space: nowrap; z-index: 50; }
.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── 响应式：窄屏 */
@media (max-width: 768px) {
  .hamburger-btn { display: flex; align-items: center; justify-content: center; }
  .pair-sub { display: none; }
}
</style>
