<script setup lang="ts">
// ============================================================
// components/dialog/DialogView.vue —— 统一会话视图（direct + group 同一内核）
//
// 阶段 3 合并产物：ChatView.vue + GroupChat.vue → 单渲染内核。
//   · group prop 为空 → direct 会话（token 仪表盘 / 压缩 / System Prompt / 工具定义 / 更多菜单）
//   · group prop 非空 → 群聊（成员抽屉 / 改名 / 删除 / REST 历史）
//   · 消息渲染（滚动 / 时间分隔 / TurnDisplayItem / 回到底部 / 文件预览）完全统一
// ============================================================

import { ref, watch, nextTick, computed, inject, onMounted, onUnmounted, type Ref } from 'vue';
import type { GroupInfo, DisplayItem, ChatMessage } from '../../types';
import { VIEWER_ID } from '../../constants';
import { deleteAgent, fetchSessionTokens } from '../../api/roster';
import { deleteGroup } from '../../api/groups';
import type { SingleSession } from '../../api/singles';
import { wireRpc } from '../../api/wire';
import { useChatStore } from '../../stores/chat';
import { useAgentStore } from '../../stores/agents';
import { useSinglesStore } from '../../stores/singles';
import { useFeedStore } from '../../stores/feed';
import { useUiStore } from '../../stores/ui';
import { directDialog, groupDialog, singleDialog, bucketKey } from '../../utils/feed';
import { formatRelativeTime, insertTimeSeparators } from '../../utils/format';
import { traceSwitch } from '../../utils/switchTrace';
import { useChatShell } from '../../composables/useChatShell';
import { useQueuedMessages, type QueuedMessage } from '../../composables/useQueuedMessages';
import { Modal, Icon, FeedbackNotice } from '../../ui';
import TurnDisplayItem from '../chat/Message/TurnDisplayItem.vue';
import ChatInput from '../ChatInput.vue';
import GroupDrawer from './GroupDrawer.vue';
import TaskDock from '../tracking/TaskDock.vue';
import QueueDock from '../chat/QueueDock.vue';
import InteractionBar from '../InteractionBar.vue';

const props = defineProps<{
  group: GroupInfo | null;
  /** 独立会话（P3 single；非空 = single 视角，消息渲染/direct 输入复用） */
  single?: SingleSession | null;
}>();
const emit = defineEmits<{
  (e: 'groupDeleted', groupId: string): void;
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();
const singlesStore = useSinglesStore();
const wireStoreConnected = ref(false);
wireRpc.onWireOpen(() => { wireStoreConnected.value = true; });
wireRpc.onWireClose(() => { wireStoreConnected.value = false; });
const feed = useFeedStore();
const ui = useUiStore();

/** 注入父组件提供的切换侧边栏方法 */
const toggleSidebar = inject<() => void>('toggleSidebar', () => {});
/** 消息左右对齐基准（用户消息靠右） */
const settingsAgentId = inject<Ref<string>>('settingsAgentId', ref(VIEWER_ID.value));
/** 打开 Agent 设置（由 App.vue provide，定位到该 Agent） */
const openAgentSettings = inject<(agentId: string) => void>('openAgentSettings', () => {});

const isGroup = computed(() => !!props.group);
const isSingle = computed(() => !!props.single);
const messagesContainer = ref<HTMLElement>();

/** 头部目标 Agent（single 场景 = 会话引用的 agentId；否则当前激活 Agent） */
const headerAgentId = computed(() => props.single?.agentId ?? agentStore.activeAgentId);

// ── next-turn 排队面（DSH queue 姿势；单一事实源在本视图，QueueDock 纯展示、
//    ChatInput 只收计数/整队列插话回调）──
const dockAgentId = computed(() => props.single?.agentId || agentStore.activeAgentId || null);
const dockConversationId = computed(() =>
  props.single ? props.single.id
    : (agentStore.activeAgentId ? bucketKey(VIEWER_ID.value, agentStore.activeAgentId) : null));
const queued = useQueuedMessages(dockAgentId, dockConversationId);
const queuedItems = computed(() => queued.items.value);

/** 行级插话（QueueDock ⚡ 立即发送）：转移到活跃 run 下一步；
 *  'requeued' = 窗口刚关的收敛竞态——条目留队正常投递，不报失败（DSH 语义） */
async function steerQueuedItem(item: QueuedMessage) {
  if (await queued.steer(item.id) === 'steered') chatStore.appendOwnSteered(item.preview);
}
async function removeQueuedItem(id: string) {
  await queued.remove(id);
}
/** 整队列插话（DSH 手势：空草稿 + Cmd/Ctrl+Enter → FIFO 全部插话进运行中轮次） */
async function steerAllQueued() {
  if (!chatStore.contextBusy) return;
  for (;;) {
    const first = queued.items.value[0];
    if (!first) break;
    const outcome = await queued.steer(first.id);
    if (outcome !== 'steered') break; // 窗口已关/条目失效：停止（不报失败）
    chatStore.appendOwnSteered(first.preview);
  }
}

/** 当前对话标识 */
const dialogId = computed(() => {
  if (props.single) return singleDialog(props.single.id);
  if (props.group) return groupDialog(props.group.group_id);
  const a = agentStore.activeAgentId;
  return a ? directDialog(a) : null;
});

/** rawMessages 来自统一信息流（单一真相源） */
const rawMessages = computed<ChatMessage[]>(() => (dialogId.value ? feed.getRaw(dialogId.value) : []));

// ── 标题 ──
const activeAgentName = computed(() => {
  const id = headerAgentId.value;
  if (!id) return '';
  // getAgentName 含预设目录解析（预设 Agent 不在 agents 列表）
  return agentStore.getAgentName(id) || id;
});
const title = computed(() => {
  if (props.single) {
    if (!props.single.agentId) return props.single.title || '新会话';
    return props.single.title
      || `${activeAgentName.value || props.single.agentId} · 独立会话`;
  }
  if (props.group) return props.group.name;
  return agentStore.activeAgentId ? activeAgentName.value : '选择一个 Agent 开始对话';
});

// ── 发送 ──
const groupTurnInProgress = ref(false);

function sendGroupMessage(content: string, files?: import('@/types').FileAttachment[]) {
  if (!props.group || (!content.trim() && !files?.length)) return;
  groupTurnInProgress.value = true;
  shell.scrollToBottom();
  // 群聊附件（M4）：文本行合成 + 图片引用旁挂（与直答路径同构——
  // chat store 的 composeContent/imageAttachmentsOf 单源复用）
  const composed = chatStore.composeContent(content, files);
  const attachments = chatStore.imageAttachmentsOf(files);
  // Port B：group/send 受理（rpc result）即解锁；失败同样解锁（10s 兜底保留）
  void wireRpc.call('group/send', {
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

// ── 历史加载 ──
const isLoadingMore = ref(false);

/** direct：触发加载更多历史并保持滚动位置（新消息插入顶部，scrollTop 同步下移） */
async function triggerLoadMore() {
  if (isGroup.value) return; // 群聊走 loadOlderGroupHistory
  if (!messagesContainer.value || isLoadingMore.value) return;
  if (!chatStore.hasMoreHistory || chatStore.loadingHistory) return;
  traceSwitch('load-more', `${dialogId.value}（内容不满一屏自动续拉 → 加载指示器再次出现）`);
  isLoadingMore.value = true;
  const container = messagesContainer.value;
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
    const container = messagesContainer.value;
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

/** 滚动到顶部阈值：按模式加载更早历史 */
function onTopThreshold() {
  if (isGroup.value) {
    void loadOlderGroupHistory();
  } else {
    void triggerLoadMore();
  }
}

// ── 滚动外壳（统一 direct/group）──
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

const shell = useChatShell({
  container: messagesContainer,
  onTopThreshold,
  signal: () => [rawMessages.value.length, streamingTailLen.value] as const,
});
// 模板中嵌套 ref 不会自动解包，此处显式解包供 v-if 使用
const isUserScrolledUp = computed(() => shell.isUserScrolledUp.value);

// ── 渲染模型（统一：turn + time-separator + event/error 分隔）──
const turns = computed(() => (dialogId.value ? feed.getTurns(dialogId.value).value : []));

const turnDisplayItems = computed<DisplayItem[]>(() => {
  const turnList = turns.value;
  if (turnList.length === 0) return [];
  const items: DisplayItem[] = [];
  for (let i = 0; i < turnList.length; i++) {
    const t = turnList[i];
    // 稳定 key：agent + 时间戳 + 内容长度（数组下标 i 在历史前插时全量平移，
    // 用作 key 会导致整个列表重建——用户展开态/卡片内部状态全部丢失）
    const ts = t.final?.timestamp ?? t.steps[0]?.assistant.timestamp ?? i;
    const stableKey = `turn-${t.agent_id}-${ts}-${t.final?.content?.length ?? 0}-${t.steps.length}`;
    // event 消息（定时/归档/继续/重启等系统事件）→ 特殊分隔符
    if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'event') {
      const label = (t.final.content || t.final.source?.summary || '').trim();
      items.push({ type: 'event', index: -1, timeText: label, timestamp: t.final.timestamp, key: `event-${ts}-${label.length}` });
      continue;
    }
    // error 消息 → 红色错误分隔符
    if (t.agent_id !== VIEWER_ID.value && t.final?.role === 'error') {
      items.push({ type: 'error', index: -1, timeText: t.final.content, timestamp: t.final.timestamp, key: `error-${ts}-${t.final.content?.length ?? 0}` });
      continue;
    }
    items.push({ type: 'turn' as const, turn: t, index: i, key: stableKey });
  }
  return insertTimeSeparators(items);
});

// ════════════ direct 特有：Token 仪表盘 ════════════
interface SessionTokens {
  tokenCount: number; messageCount: number; maxContextTokens: number; usagePercent: number;
  avgTokensPerMsg: number; estimatedMsgsRemaining: number; status: 'low' | 'moderate' | 'high' | 'critical';
}
const sessionTokens = ref<SessionTokens | null>(null);

async function fetchTokenBaseline(clearFirst = false) {
  const agentId = agentStore.activeAgentId;
  if (!agentId || isGroup.value || isSingle.value) return; // 仪表盘 pair 专属（single 无 token 语义）
  if (clearFirst) sessionTokens.value = null;
  const seq = ++tokenFetchSeq; // 竞态守卫：快速切换 Agent 时 A 的迟到响应不得覆盖 B
  try {
    const data = await fetchSessionTokens(agentId);
    if (seq !== tokenFetchSeq) return;
    sessionTokens.value = {
      tokenCount: data.tokenCount ?? 0,
      messageCount: data.messageCount ?? 0,
      maxContextTokens: data.maxContextTokens ?? 1_000_000,
      usagePercent: data.usagePercent ?? 0,
      avgTokensPerMsg: data.avgTokensPerMsg ?? 0,
      estimatedMsgsRemaining: data.estimatedMsgsRemaining ?? 0,
      status: data.status ?? 'low',
    };
  } catch { /* 失败保留旧值，不闪烁 */ }
}
let tokenFetchSeq = 0;

watch(() => agentStore.activeAgentId, () => { fetchTokenBaseline(true); }, { immediate: true });
watch(() => chatStore.lastRunEndAt, () => { fetchTokenBaseline(); });
watch(() => chatStore.hasMoreHistory, () => { if (!chatStore.hasMoreHistory) fetchTokenBaseline(); });

// ════════════ direct 特有：System Prompt / 工具定义 ════════════
const showSystemPrompt = ref(false);
const showToolDefs = ref(false);

const toolDefsXml = computed(() => {
  const defs = chatStore.toolDefs;
  if (!defs.length) return '';
  const lines: string[] = ['<functions>'];
  for (const def of defs) {
    const fn = def.function;
    lines.push('  <function>');
    lines.push(`    <name>${escapeXml(fn.name)}</name>`);
    lines.push(`    <description>${escapeXml(fn.description)}</description>`);
    lines.push(`    <parameters>${JSON.stringify(fn.parameters, null, 6)}</parameters>`);
    lines.push('  </function>');
  }
  lines.push('</functions>');
  return lines.join('\n');
});

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      chatStore.copyFeedback = true;
      setTimeout(() => { chatStore.copyFeedback = false; }, 2000);
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    chatStore.copyFeedback = true;
    setTimeout(() => { chatStore.copyFeedback = false; }, 2000);
  } catch { /* 复制失败，静默处理 */ }
  document.body.removeChild(textarea);
}

/** 压缩对话：触发 Agent 整理记忆后裁剪消息 */
function handleCompress() {
  if (!agentStore.activeAgentId || chatStore.turnInProgress || chatStore.compressPending) return;
  chatStore.compressSession();
}

// ════════════ direct 特有：更多菜单 ════════════
const showMoreMenu = ref(false);
function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
  if (showMoreMenu.value) {
    setTimeout(() => document.addEventListener('click', closeMoreMenu, { once: true }), 0);
  }
}
function closeMoreMenu() { showMoreMenu.value = false; }

// ════════════ 删除确认（agent / group / single 统一）════════════
const deleteTarget = ref<{ kind: 'agent' | 'group' | 'single'; id: string; name: string } | null>(null);
const deleteError = ref('');
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    const t = deleteTarget.value;
    if (t.kind === 'agent') {
      await deleteAgent(t.id);
      if (agentStore.activeAgentId === t.id) agentStore.selectAgent(t.id);
      agentStore.requestAgents();
    } else if (t.kind === 'single') {
      await singlesStore.archive(t.id);
    } else {
      await deleteGroup(t.id);
      emit('groupDeleted', t.id);
    }
    deleteTarget.value = null;
  } catch (err: any) {
    deleteError.value = `删除失败: ${err.message}`;
  } finally {
    deleting.value = false;
  }
}

// ════════════ group 特有：群聊信息抽屉（委托 GroupDrawer）════════════
const showDrawer = ref(false);
function toggleDrawer() { showDrawer.value = !showDrawer.value; }

// ════════════ 文件预览（全局单例：stores/ui.ts）════════════
function handlePreviewFile(payload: string | { filePath: string; agentId?: string }) {
  if (typeof payload === 'string') {
    ui.openPreview(payload, agentStore.activeAgentId || '');
  } else {
    ui.openPreview(payload.filePath, payload.agentId || agentStore.activeAgentId || '');
  }
}

// ════════════ 群组切换：加载该群组历史（实时 group.message 由 feed.ingest 统一处理）════════════
watch(() => props.group?.group_id, (newId, oldId, onCleanup) => {
  if (newId && newId !== oldId) {
    // 取消守卫：快速 A→B 切群时，A 的迟到回调不得对 B 的视图滚底
    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    feed.loadGroupHistory(groupDialog(newId), newId).then(() => {
      if (!cancelled) nextTick(() => shell.scrollToBottom());
    });
  }
}, { immediate: true });

// ════════════ 会话切换：重置滚动外壳闭包状态 + 滚动到底部 ════════════
// 三视角复用同一组件实例，useChatShell 的 isUserScrolledUp/lastScrollTop
// 是闭包状态——不重置会跨会话残留（新会话不足一屏时 scroll 事件不触发，
// 残留的"用户上翻"标志会停掉自动滚底并悬浮"回到底部"按钮）。
watch(dialogId, () => {
  traceSwitch('view-switch', `${dialogId.value}（DOM 更新前的 watch）`);
  shell.reset();
  shell.scrollToBottom();
  nextTick(() => {
    traceSwitch('dom-updated', `${dialogId.value} → ${rawMessages.value.length} 条消息上屏`);
  });
});

// ════════════ 切换 Agent（direct）：统一加载历史 + 滚动到底部 ════════════
// 历史加载收敛于此（与 single 模式对齐）——此前分散在 AgentList/RunTracking/
// RunTrackingPanel/chat.ts 四处调用方，任何新导航入口漏调即"空白会话直到刷新"。
// 保留的重复调用（矩阵入口的同 id 重入、chat.ts 恢复路径）由 feed 的
// requestId 时序守卫去重，不产生错误合并。
const isInitialHistoryLoad = ref(true);
watch(() => agentStore.activeAgentId, (id) => {
  if (isGroup.value || isSingle.value) return;
  traceSwitch('view-watch', `activeAgentId=${id || '(空)'}`);
  isInitialHistoryLoad.value = true;
  if (id) chatStore.loadHistory(VIEWER_ID.value, id);
  shell.scrollToBottom();
});

// ════════════ single 切换：加载该会话历史（feed 分区 singleDialog；WS 流事件按 dialogId 自动路由）════════════
watch(() => props.single?.id, (newId, oldId) => {
  if (!newId || newId === oldId) return;
  traceSwitch('view-watch', `single=${newId.slice(-8)}`);
  isInitialHistoryLoad.value = true;
  chatStore.loadHistory(VIEWER_ID.value, props.single!.agentId, newId);
  shell.scrollToBottom();
}, { immediate: true });

// 每次历史加载完成：首次加载 → 滚动到底部；续拉 → 保持位置。
// 群聊不走此 direct 自动续拉逻辑（否则空群聊 hasMore=true + 内容不足一屏会无限递归
// triggerLoadMore → 页面卡死）；群聊上翻由 loadOlderGroupHistory 按滚动触发。
watch(() => chatStore.loadingHistory, (loading, wasLoading) => {
  if (isGroup.value || loading || !wasLoading) return;
  traceSwitch('loading(false)', `${dialogId.value} 首屏=${isInitialHistoryLoad.value} hasMore=${chatStore.hasMoreHistory}`);
  if (isInitialHistoryLoad.value) {
    isInitialHistoryLoad.value = false;
    nextTick(() => shell.scrollToBottom());
  }
  if (chatStore.hasMoreHistory) {
    nextTick(() => {
      const el = messagesContainer.value;
      if (el && el.scrollHeight <= el.clientHeight && !isLoadingMore.value) void triggerLoadMore();
    });
  }
});
// loading=true 的时刻（加载指示器出现的时刻；click→此点 = 首帧未更新的时长）
watch(() => chatStore.loadingHistory, (loading) => {
  if (loading && !isGroup.value) traceSwitch('loading(true)', `${dialogId.value}（加载指示器应当出现）`);
});
</script>

<template>
  <div v-if="dialogId" class="chat-view">
    <!-- ═══ 头部 ═══ -->
    <div class="chat-header">
      <button v-if="!isGroup" class="hamburger-btn" @click="toggleSidebar" title="菜单">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
      </button>
      <div class="header-info">
        <span class="agent-label">{{ title }}</span>
      </div>
      <span v-if="isGroup" class="participant-count">{{ props.group!.participants.length }} 个参与者</span>
      <div class="header-actions">
        <!-- direct：Token 仪表盘（pair 专属） -->
        <div v-if="!isGroup && !isSingle && sessionTokens && sessionTokens.messageCount > 0" class="session-token-gauge" :title="`${sessionTokens.tokenCount.toLocaleString()} / ${sessionTokens.maxContextTokens.toLocaleString()} tokens · ${sessionTokens.messageCount} 条消息 · 约 ${sessionTokens.estimatedMsgsRemaining} 条后需归档`">
          <div class="gauge-bar">
            <div class="gauge-fill" :class="sessionTokens.status" :style="{ width: sessionTokens.usagePercent + '%' }"></div>
          </div>
          <span class="gauge-pct" :class="sessionTokens.status">{{ Math.round(sessionTokens.usagePercent) }}%</span>
        </div>

        <!-- direct：归档 + 反馈（pair 专属） -->
        <div v-if="!isGroup && !isSingle" class="compress-wrap">
          <button
            v-if="agentStore.activeAgentId && sessionTokens && sessionTokens.messageCount > 0"
            class="compress-btn"
            :class="{ 'compress-btn--pending': chatStore.compressPending }"
            :disabled="chatStore.turnInProgress || chatStore.compressPending"
            @click="handleCompress()"
            :title="chatStore.compressPending ? '正在归档整理记忆…' : '归档对话：先整理记忆，再归档早期消息'"
          >
            <svg v-if="!chatStore.compressPending" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
            <span v-else class="compress-btn__spinner"></span>
          </button>
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
              variant="chip"
              :text="chatStore.busyFeedback"
              :tone="chatStore.busyTone"
            />
          </transition>
        </div>

        <!-- single：发送失败/引导反馈（pair 同款提示；此前只在 pair 渲染——独立会话
             投递失败完全不可见，表现为"发送无反应"） -->
        <transition name="fade">
          <FeedbackNotice
            v-if="!isGroup && isSingle && chatStore.busyFeedback"
            variant="chip"
            :text="chatStore.busyFeedback"
            :tone="chatStore.busyTone"
          />
        </transition>

        <!-- direct/single：System Prompt 预览 -->
        <button v-if="!isGroup && headerAgentId" class="settings-btn" @click="chatStore.requestSystemPrompt(headerAgentId); showSystemPrompt = true" :disabled="chatStore.systemPromptLoading" title="预览 System Prompt">
          <Icon name="file-text" :size="18" />
        </button>

        <!-- direct/single：Agent 配置（预设 Agent 无实体配置，不显示设置入口） -->
        <button v-if="!isGroup && headerAgentId && !agentStore.isPreset(headerAgentId)" class="settings-btn" @click="openAgentSettings(headerAgentId)" title="Agent 配置">
          <Icon name="settings" :size="18" />
        </button>

        <!-- direct/single：更多操作菜单（single 空会话也可归档清理） -->
        <div v-if="!isGroup && (headerAgentId || isSingle)" class="more-menu-wrapper">
          <button class="settings-btn" @click.stop="toggleMoreMenu" title="更多操作">
            <Icon name="more-horizontal" :size="18" />
          </button>
          <Transition name="dropdown">
            <div v-if="showMoreMenu" class="more-dropdown" @click.stop>
              <button v-if="headerAgentId" class="dropdown-item" @click="showMoreMenu = false; chatStore.requestToolDefs(headerAgentId); showToolDefs = true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" /></svg>
                工具定义预览
              </button>
              <div v-if="headerAgentId" class="dropdown-divider"></div>
              <button v-if="isSingle" class="dropdown-item danger" @click="showMoreMenu = false; deleteTarget = { kind: 'single', id: props.single!.id, name: title }">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                归档独立会话
              </button>
              <button v-else class="dropdown-item danger" @click="showMoreMenu = false; deleteTarget = { kind: 'agent', id: agentStore.activeAgentId, name: activeAgentName }">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                删除 Agent
              </button>
            </div>
          </Transition>
        </div>

        <!-- group：群聊信息 -->
        <button v-if="isGroup" class="settings-btn" :class="{ active: showDrawer }" @click.stop="toggleDrawer" title="群聊信息">
          <Icon name="more-horizontal" :size="18" />
        </button>
      </div>
    </div>

    <div v-if="!isGroup && !wireStoreConnected" class="connection-status">
      <span>[WARN] 连接已断开，正在重连...</span>
    </div>

    <div class="chat-body">
      <div class="chat-main" @click="showDrawer = false">
        <div class="messages-wrapper">
          <div ref="messagesContainer" class="messages-container" @scroll="shell.onScroll">
            <div class="messages-content">
              <!-- 空态 gate：历史加载中显示加载占位，不显示"开始对话"——首开有历史
                   的会话（分区尚空、状态 loading）不再被误导成空白新会话。
                   与 PairDialogView 的 rawMessages.length===0 && !loading 同模式 -->
              <div v-if="rawMessages.length === 0" class="empty-state">
                <template v-if="chatStore.loadingHistory">
                  <span class="history-spinner empty-state-spinner"></span>
                  <p>正在加载历史消息…</p>
                </template>
                <template v-else>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <p>{{ isGroup ? '群聊开始 — 发送第一条消息吧' : '开始对话 — 发送第一条消息吧' }}</p>
                </template>
              </div>

              <!-- 加载更多历史消息指示器（空态时由上方加载占位承担，避免双重提示） -->
              <div v-if="rawMessages.length > 0 && (isLoadingMore || chatStore.loadingHistory)" class="history-loading">
                <span class="history-spinner"></span>
                <span class="history-loading-text">加载历史消息中…</span>
              </div>

              <template v-for="(item, idx) in turnDisplayItems" :key="item.key ?? `${item.type}-${idx}`">
                <div v-if="item.type === 'time-separator'" class="time-separator">
                  <span class="time-separator-text">{{ item.timeText }}</span>
                </div>
                <div v-else-if="item.type === 'event'" class="event-separator">
                  <span v-if="item.timestamp && item.showTime !== false" class="event-separator-time">{{ formatRelativeTime(item.timestamp) }}</span>
                  <span class="event-separator-text">{{ item.timeText }}</span>
                </div>
                <div v-else-if="item.type === 'error'" class="error-separator">
                  <span v-if="item.timestamp && item.showTime !== false" class="error-separator-time">{{ formatRelativeTime(item.timestamp) }}</span>
                  <span class="error-separator-text">{{ item.timeText }}</span>
                </div>
                <TurnDisplayItem
                  v-else
                  :turn="item.turn!"
                  :index="item.index"
                  :settings-agent-id="settingsAgentId"
                  :show-actions="!isGroup"
                  @regenerate="chatStore.regenerateMessage"
                  @delete-message="chatStore.deleteMessage"
                  @edit="(msgId: any, newContent: any) => chatStore.editMessage(msgId, newContent)"
                  @continue-generation="chatStore.continueGeneration()"
                  @preview-file="handlePreviewFile"
                />
              </template>
            </div>
          </div>

          <Transition name="scroll-btn">
            <button v-if="isUserScrolledUp" class="scroll-to-bottom-btn" @click="shell.scrollToBottomAndReset" title="回到底部">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          </Transition>
        </div>

        <!-- 任务追踪 dock（goal/todo；DSH input dock 姿势——composer 上方）：
             直答 = 激活 Agent 的对桶；独立会话 = 会话登记 Agent × sid；
             群 = 多成员无单一归属桶，隐藏。数据/刷新在 TaskDock 内自理 -->
        <TaskDock
          v-if="!isGroup"
          :agent-id="dockAgentId"
          :conversation-id="dockConversationId"
        />
        <!-- 排队 dock（DSH QueueDock 姿势——composer 上方、TaskDock 之后）：
             忙时发送的消息排队等本轮结束；行级"立即发送"（插话）与删除都在
             这里——输入框不再放插话按钮（DSH 同款）。群聊不参与 -->
        <QueueDock
          v-if="!isGroup"
          :items="queuedItems"
          :busy="chatStore.contextBusy"
          :on-steer="steerQueuedItem"
          :on-remove="removeQueuedItem"
        />
        <!-- ask_questions 决策 dock（composer 上方、QueueDock 之后——待决事项
             紧贴输入框；TaskDock/QueueDock 同族卡样式）：Agent 提问等待用户
             作答；会话归属门控在组件内（跨会话串台/群聊无单一归属时隐藏） -->
        <InteractionBar />
        <ChatInput
          v-if="isGroup"
          :disabled="groupTurnInProgress"
          :placeholder="groupTurnInProgress ? 'Agent 回复中...' : '输入消息发送到群聊...'"
          :on-send="sendGroupMessage"
        />
        <ChatInput
          v-else
          :single="props.single ?? null"
          :queued-count="queuedItems.length"
          :on-steer-all-queued="steerAllQueued"
        />
      </div>

      <!-- ═══ group：右侧抽屉（GroupDrawer）═══ -->
      <Transition v-if="isGroup && props.group" name="drawer-slide">
        <GroupDrawer
          v-if="showDrawer"
          :group="props.group"
          :visible="showDrawer"
          @delete-group="(gid: string) => deleteTarget = { kind: 'group', id: gid, name: props.group!.name }"
        />
      </Transition>
    </div>

    <!-- ═══ 删除确认对话框（agent / group 统一）═══ -->
    <Modal :visible="!!deleteTarget" :width="380" @close="deleteTarget = null">
      <div class="delete-dialog">
        <div class="delete-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        </div>
        <h4>{{ deleteTarget?.kind === 'group' ? '删除群聊群组' : deleteTarget?.kind === 'single' ? '归档独立会话' : '永久删除 Agent' }}</h4>
        <p class="delete-warning">确定要{{ deleteTarget?.kind === 'single' ? '归档' : '删除' }} <strong>{{ deleteTarget?.name }}</strong> 吗？</p>
        <p class="delete-detail">此操作将{{ deleteTarget?.kind === 'group' ? '删除该群组的所有消息记录' : deleteTarget?.kind === 'single' ? '归档该会话（消息保留，可从数据目录找回）' : '删除该 Agent 的所有配置、会话历史和凭据' }}，<br /><span class="delete-emphasis">{{ deleteTarget?.kind === 'single' ? '归档后不再出现在列表中。' : '不可恢复，不可撤销。' }}</span></p>
        <div v-if="deleteError" class="delete-error">{{ deleteError }}</div>
        <div class="dialog-actions">
          <button class="btn-cancel" @click="deleteTarget = null" :disabled="deleting">取消</button>
          <button class="btn-delete" @click="confirmDelete" :disabled="deleting">{{ deleting ? '删除中…' : '确认删除' }}</button>
        </div>
      </div>
    </Modal>

    <!-- ═══ System Prompt 预览弹窗（direct）═══ -->
    <Modal :visible="showSystemPrompt" :width="700" @close="showSystemPrompt = false; chatStore.clearSystemPrompt()">
      <div class="system-prompt-dialog">
        <div class="prompt-header">
          <h4>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            System Prompt · {{ activeAgentName }}
          </h4>
          <button class="close-btn" @click="showSystemPrompt = false; chatStore.clearSystemPrompt()" title="关闭"><Icon name="x" :size="14" /></button>
        </div>
        <div class="prompt-body">
          <div v-if="chatStore.systemPromptLoading" class="prompt-loading"><span class="history-spinner"></span><span>正在组装 System Prompt…</span></div>
          <div v-else-if="chatStore.systemPromptError" class="prompt-error">{{ chatStore.systemPromptError }}</div>
          <pre v-else class="prompt-content">{{ chatStore.systemPromptContent }}</pre>
        </div>
        <div class="prompt-footer">
          <span class="prompt-info">共 {{ chatStore.systemPromptContent.length }} 字符</span>
          <div class="prompt-actions">
            <button class="btn-refresh" @click="chatStore.requestSystemPrompt()" :disabled="chatStore.systemPromptLoading" title="刷新">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              刷新
            </button>
            <button class="btn-copy" @click="copyText(chatStore.systemPromptContent)" :disabled="chatStore.copyFeedback" title="复制到剪贴板">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              {{ chatStore.copyFeedback ? '已复制' : '复制' }}<Icon v-if="chatStore.copyFeedback" name="check" :size="11" />
            </button>
            <button class="btn-cancel" @click="showSystemPrompt = false; chatStore.clearSystemPrompt()">关闭</button>
          </div>
        </div>
      </div>
    </Modal>

    <!-- ═══ 工具定义预览弹窗（direct）═══ -->
    <Modal :visible="showToolDefs" :width="700" @close="showToolDefs = false; chatStore.clearToolDefs()">
      <div class="system-prompt-dialog">
        <div class="prompt-header">
          <h4>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" /></svg>
            工具定义 · {{ activeAgentName }}
          </h4>
          <button class="close-btn" @click="showToolDefs = false; chatStore.clearToolDefs()" title="关闭"><Icon name="x" :size="14" /></button>
        </div>
        <div class="prompt-body">
          <div v-if="chatStore.toolDefsLoading" class="prompt-loading"><span class="history-spinner"></span><span>正在获取工具定义…</span></div>
          <div v-else-if="chatStore.toolDefsError" class="prompt-error">{{ chatStore.toolDefsError }}</div>
          <div v-else-if="!chatStore.toolDefs.length" class="prompt-loading">该 Agent 没有注册任何工具</div>
          <pre v-else class="prompt-content">{{ toolDefsXml }}</pre>
        </div>
        <div class="prompt-footer">
          <span class="prompt-info">{{ chatStore.toolDefs.length }} 个工具</span>
          <div class="prompt-actions">
            <button class="btn-refresh" @click="chatStore.requestToolDefs()" :disabled="chatStore.toolDefsLoading" title="刷新">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              刷新
            </button>
            <button class="btn-copy" @click="copyText(toolDefsXml)" :disabled="chatStore.copyFeedback" title="复制到剪贴板">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              {{ chatStore.copyFeedback ? '已复制' : '复制' }}<Icon v-if="chatStore.copyFeedback" name="check" :size="11" />
            </button>
            <button class="btn-cancel" @click="showToolDefs = false; chatStore.clearToolDefs()">关闭</button>
          </div>
        </div>
      </div>
    </Modal>
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
.agent-label { font-size: 15px; font-weight: 600; color: var(--color-text-primary); }
.participant-count { font-size: 12px; color: var(--color-text-tertiary); }

/* 汉堡菜单按钮：默认隐藏，窄屏显示 */
.hamburger-btn {
  display: none; background: none; border: none; cursor: pointer;
  color: var(--color-text-secondary); padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.hamburger-btn:hover { background: var(--color-bg-surface); color: var(--color-text-primary); }

.header-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.settings-btn {
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer; color: var(--color-text-secondary);
  padding: 6px; border-radius: var(--radius-sm); line-height: 0; flex-shrink: 0;
}
.settings-btn:hover, .settings-btn.active { background: var(--color-bg-surface); color: var(--color-text-primary); }
.settings-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.chat-body { flex: 1; display: flex; overflow: hidden; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.connection-status { text-align: center; padding: 6px; font-size: 12px; color: var(--color-warning); background: var(--color-bg-surface); flex-shrink: 0; }

/* 消息区 */
.messages-wrapper { flex: 1; position: relative; overflow: hidden; }
.messages-container { height: 100%; overflow-y: auto; overflow-x: hidden; padding: var(--space-md); }
.messages-content { display: flex; flex-direction: column; gap: var(--space-sm); width: 100%; max-width: 100%; margin: 0 auto; min-height: 100%; }
.messages-container::-webkit-scrollbar { width: 6px; }
.messages-container::-webkit-scrollbar-track { background: transparent; }
.messages-container::-webkit-scrollbar-thumb { background: var(--color-border-primary); border-radius: 3px; }
.messages-container::-webkit-scrollbar-thumb:hover { background: var(--color-primary); }

.time-separator { display: flex; align-items: center; justify-content: center; user-select: none; }
.time-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; }
.event-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; width: 100%; max-width: 720px; margin: 4px auto; padding-left: 42px; padding-right: 42px; }
.event-separator-time { font-size: 11px; color: var(--color-text-tertiary, #999); letter-spacing: 0.3px; line-height: 1.4; }
.event-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; white-space: pre-line; text-align: center; word-break: break-word; overflow-wrap: anywhere; max-width: 100%; }
.error-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; margin: 4px 0; padding-left: 42px; padding-right: 42px; }
.error-separator-time { font-size: 11px; color: color-mix(in srgb, var(--color-error, #e74c3c) 70%, transparent); letter-spacing: 0.3px; line-height: 1.4; }
.error-separator-text { font-size: 12px; color: var(--color-error, #e74c3c); padding: 2px 12px; letter-spacing: 0.5px; text-align: center; word-break: break-word; }

.history-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 0; color: var(--color-text-muted); font-size: 13px; }
.history-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--color-border-primary); border-top-color: var(--color-primary); border-radius: 50%; animation: history-spin 0.6s linear infinite; }
/* 空态加载占位中的 spinner（居中大号；对齐空态 svg 的 margin-bottom） */
.empty-state-spinner { width: 28px; height: 28px; border-width: 3px; margin-bottom: 12px; }
@keyframes history-spin { to { transform: rotate(360deg); } }
.history-loading-text { user-select: none; }

.scroll-to-bottom-btn {
  position: absolute; bottom: 12px; right: 16px;
  width: 40px; height: 40px; border: 1px solid var(--color-border-primary, #e0e0e0);
  border-radius: 50%; background: var(--color-bg-page, #fff); color: var(--color-text-secondary, #666);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12); z-index: 50; padding: 0;
  transition: box-shadow 0.2s, transform 0.2s, background 0.2s;
}
.scroll-to-bottom-btn:hover { box-shadow: 0 4px 14px rgba(0,0,0,0.18); transform: translateY(-1px); background: var(--color-bg-surface, #f5f5f5); }
.scroll-to-bottom-btn:active { transform: translateY(0); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.2s, transform 0.2s; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; transform: translateY(8px); }

/* ── Token 仪表盘 ── */
.session-token-gauge { display: flex; align-items: center; gap: 6px; margin-left: 6px; padding: 2px 0; flex-shrink: 0; }
.gauge-bar { width: 72px; height: 6px; border-radius: 3px; background: var(--color-bg-hover, rgba(0,0,0,0.06)); overflow: hidden; }
.gauge-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.gauge-fill.low { background: #22c55e; }
.gauge-fill.moderate { background: #eab308; }
.gauge-fill.high { background: #f97316; }
.gauge-fill.critical { background: #ef4444; }
.gauge-pct { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.gauge-pct.low { color: #22c55e; }
.gauge-pct.moderate { color: #eab308; }
.gauge-pct.high { color: #f97316; }
.gauge-pct.critical { color: #ef4444; }

/* ── 压缩 ── */
.compress-wrap { position: relative; display: flex; align-items: center; }
.compress-btn { display: flex; align-items: center; padding: 4px; border: none; border-radius: var(--radius-sm); background: none; cursor: pointer; color: var(--color-text-muted, #888); line-height: 0; flex-shrink: 0; transition: color .15s; margin-left: 4px; }
.compress-btn:hover { color: var(--color-primary, #6366f1); background: var(--color-bg-surface); }
.compress-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.compress-btn--pending { color: var(--color-primary, #6366f1); }
.compress-btn__spinner { width: 13px; height: 13px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; display: inline-block; animation: compress-spin .7s linear infinite; }
@keyframes compress-spin { to { transform: rotate(360deg); } }
/* 归档反馈：仅定位（视觉由 FeedbackNotice chip 形态承担——tone 派生配色） */
.compress-feedback { position: absolute; right: calc(100% + 8px); top: 50%; transform: translateY(-50%); pointer-events: none; }
.fade-enter-active, .fade-leave-active { transition: opacity .25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 更多菜单 */
.more-menu-wrapper { position: relative; }
.more-dropdown { position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--bg-raised, var(--color-bg-page)); border: 1px solid var(--line, var(--color-border-secondary)); border-radius: 10px; box-shadow: var(--shadow-pop, 0 4px 16px rgba(0,0,0,0.1)); min-width: 180px; z-index: 300; padding: 4px; overflow: hidden; }
.dropdown-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; border-radius: 6px; background: none; color: var(--text-1, var(--color-text-primary)); font-size: 13px; cursor: pointer; text-align: left; }
.dropdown-item:hover { background: var(--role-hover-bg, var(--bg-hover)); }
.dropdown-item.danger { color: var(--err, #e74c3c); }
.dropdown-item.danger:hover { background: color-mix(in srgb, var(--err) 12%, transparent); color: var(--err); }
.dropdown-divider { height: 1px; background: var(--line, var(--color-border-secondary)); margin: 4px 8px; }
.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }

/* ── 响应式：窄屏 */
@media (max-width: 768px) {
  .hamburger-btn { display: flex; align-items: center; justify-content: center; }
  .messages-container { padding: var(--space-sm); }
  .scroll-to-bottom-btn { right: 12px; bottom: 12px; }
}
</style>

<style>
/* 删除确认对话框（全局，供 Modal 内使用） */
.delete-dialog { padding: 28px 24px 20px; text-align: center; }
.delete-icon { margin-bottom: 12px; }
.delete-dialog h4 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.delete-warning { margin: 0 0 4px; font-size: 14px; color: var(--color-text-secondary); }
.delete-warning strong { color: #e74c3c; }
.delete-detail { margin: 0 0 16px; font-size: 12px; color: var(--color-text-tertiary); line-height: 1.6; }
.delete-emphasis { color: #e74c3c; font-weight: 600; }
.delete-error { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: center; gap: 10px; }
.btn-cancel { padding: 8px 20px; border: 1px solid var(--color-border-secondary); border-radius: 6px; background: var(--color-bg-page); color: var(--color-text-secondary); font-size: 13px; cursor: pointer; }
.btn-cancel:hover { background: var(--color-bg-surface); }
.btn-delete { padding: 8px 20px; border: none; border-radius: 6px; background: #e74c3c; color: #fff; font-size: 13px; cursor: pointer; font-weight: 500; }
.btn-delete:hover { background: #c0392b; }
.btn-delete:disabled, .btn-cancel:disabled { opacity: 0.6; cursor: default; }
.close-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border: none; background: none; font-size: 20px; color: var(--color-text-secondary, #7f8c8d); cursor: pointer; border-radius: 6px; line-height: 1; flex-shrink: 0; }
.close-btn:hover { background: var(--color-bg-surface, #f0f0f0); color: var(--color-text-primary, #2c3e50); }

/* System Prompt / 工具定义 弹窗（全局） */
.system-prompt-dialog { max-height: 85vh; display: flex; flex-direction: column; }
.prompt-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.prompt-header h4 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.prompt-body { flex: 1; overflow-y: auto; padding: 16px 20px; min-height: 200px; }
.prompt-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 0; color: var(--color-text-muted); font-size: 13px; }
.prompt-error { color: #e74c3c; padding: 20px; text-align: center; font-size: 13px; }
.prompt-content { margin: 0; padding: 12px 16px; background: var(--color-bg-surface, #f8f9fa); border: 1px solid var(--color-border-secondary, #e0e0e0); border-radius: 8px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--color-text-primary, #2c3e50); max-height: 55vh; overflow-y: auto; user-select: text; -webkit-user-select: text; }
.prompt-footer { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-top: 1px solid var(--color-border-secondary, #e0e0e0); flex-shrink: 0; }
.prompt-info { font-size: 12px; color: var(--color-text-muted); }
.prompt-actions { display: flex; gap: 8px; }
.btn-refresh { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-refresh:hover:not(:disabled) { background: var(--color-bg-surface); color: var(--color-text-primary); }
.btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-copy { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; background: var(--color-primary, #4a90d9); border: none; color: #fff; transition: background 0.2s; }
.btn-copy:hover:not(:disabled) { opacity: 0.9; }
.btn-copy:disabled { opacity: 0.7; cursor: default; background: #27ae60; }
</style>
