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
//
// conversation-view-split-plan（2026-12 拆分精简）后本视图 = 纯组合壳，
// 细节各归其位（方案：src/docs/conversation-view-split-plan.md）：
//   · useConversationIdentity —— 四形态判定/对话寻址/头部目标/标题徽标/
//     席位与 dock 键的纯 computed 族
//   · useConversationHistory —— 三条 load-more 路径 + 全部装载 watch
//     （守卫与踩坑注释随迁在该文件）
//   · useGroupSend —— 群发 RPC + 发送锁（10s 兜底）
//   · header/ConversationHeader —— 头部模板与样式整块（pair 双端点头/
//     思维链开关/席位/反馈 chip 悬挂锚）
// 消息区住 TranscriptList（B 路线抽取）；滚动外壳随其在本地，本视图经
// ref 拿 scrollToBottom/reset/container（expose 面声明 = useConversationHistory
// 的 TranscriptListHandle）。
// 头部动作区开 conversation:header-widget 席位（list，order 序）：jobs chip
//（jobs 行）/ Token 仪表·System Prompt 预览（本行出厂）/ Agent·single 动作
//（agents/singles 行）经贡献自取 ownerProps；System Prompt 预览弹窗走
// overlay 席位（conversation 出厂贡献，开关态住 ui store）。
// ============================================================

import { ref, computed, inject, type Ref } from 'vue';
import type { Turn } from './types.ts';
import { VIEWER_ID } from './viewer.ts';
import { useChatStore } from './chatStore.ts';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { useClientContext } from 'ac-client-runtime';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { bucketKey } from './feed.ts';
import { useQueueSeat } from './useQueuedMessages.ts';
import TranscriptList from './TranscriptList.vue';
import ConversationHeader from './header/ConversationHeader.vue';
import ComposerDock from './ComposerDock.vue';
import ChatInput from './ChatInput.vue';
import { useTurnDisplayItems } from './useTurnDisplayItems.ts';
import { useConversationIdentity, type ConversationViewProps } from './useConversationIdentity.ts';
import { useGroupSend } from './useGroupSend.ts';
import { useFeedStore } from './feedStore.ts';
import { useConversationHistory, type TranscriptListHandle } from './useConversationHistory.ts';

const props = defineProps<ConversationViewProps>();
const chatStore = useChatStore();
const roster = useRosterCore();
// feed 统一信息流（本视图剩余用点：isSingleFresh 空判定 / turns 渲染源；
// 历史装载路径的 feed 用点已随 useConversationHistory 迁出）
const feed = useFeedStore();
// rpc 契约面（宿主 'rpc' 服务——wireRpc 薄壳；群发/连接态经此）
const rpc = useClientContext()?.rpc ?? null;
// 连接态初值取现态（M27 S3-1b 回归修复）：行 client 经 boot graph 异步
// 装载后，WS 常在视图挂载前已开——onOpen 只在「下一次」开时触发，
// 纯事件初值 false 会让连接条永久误显（注册顺序竞态）。
// 桩缺省（connected 未提供）按已连接处理（离线桩不误显断连条）
const wireStoreConnected = ref(rpc?.connected?.() ?? true);
rpc?.onOpen?.(() => { wireStoreConnected.value = true; });
rpc?.onClose?.(() => { wireStoreConnected.value = false; });
const ui = useUiStore();
/** 消息左右对齐基准（用户消息靠右；pair = viewer：两端非 user 全左气泡） */
const settingsAgentId = inject<Ref<string>>('settingsAgentId', ref(VIEWER_ID.value));

// ── 身份派生层（conversation-view-split-plan ①：四形态判定/对话寻址/头部
//    目标/标题徽标/席位与 dock 键的纯 computed 族单源）──
const identity = useConversationIdentity(props);
const {
  isGroup, isSingle, isPair,
  dialogId, rawMessages,
  presetChipLabel, title,
  jobsConversationId, headerWidgetData,
  dockAgentId, dockConversationId,
} = identity;

/** 消息区 ref（TranscriptList 持滚动外壳，本视图经 expose 面驱动；
 *  类型 = TranscriptListHandle 结构化声明——见 useConversationHistory） */
const transcript = ref<TranscriptListHandle>();



// ── next-turn 排队面（座位键 = 身份派生层 dock 键；useQueueSeat 与
//    QueueDockHost 贡献同轴同实例，行级动作在贡献容器内编排——本视图
//    仅消费计数/整队列插话〔ChatInput 接线〕；agentId 兜底踩坑注释已
//    随键迁 useConversationIdentity）──
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

// ── 群发路径（conversation-view-split-plan ④：RPC group/send + 发送锁
//    迁 useGroupSend；direct/single 走 ChatInput 默认 store.sendMessage）──
const { groupTurnInProgress, sendGroupMessage } = useGroupSend(props, transcript);

// ── 历史装载编排（conversation-view-split-plan ③：三条 load-more 路径与
//    全部装载 watch 迁 useConversationHistory——守卫与踩坑注释逐字随迁）──
const { onTopThreshold, topLoading, firstLoadPending } = useConversationHistory({ props, identity, transcript });

// ── 渲染模型（useTurnDisplayItems 单源管线——B 路线抽取）──
const turns = computed<Turn[]>(() => (dialogId.value ? feed.getTurns(dialogId.value).value : []));
const turnDisplayItems = useTurnDisplayItems(turns);

/* ── 新会话开场（2026-12 布局重设计）──
 * single 空会话：输入框区域整体居中呈现（工作区选择 | 预设模式选择
 * 置于输入卡上方）。首条消息后回到常规底部布局。direct/群/pair 无此面。
 * 空判定与 ChatInput.sessionLocked 同源口径：无 lastActivity 且 feed
 * 分区无消息（首轮流式期间文件未落盘，feed 先看到）。 */
const isSingleFresh = computed(() =>
  isSingle.value
  && !props.single!.lastActivity
  && (!dialogId.value || feed.getRaw(dialogId.value).length === 0));

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

/** TranscriptList 显示态（topLoading/firstLoadPending 由 history 层供给） */
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

// ── 会话分支（single 形态专用）：气泡分支按钮 → singleBoard.fork。
// 锚点 = 落盘行 message_id（persistedMsgId；TurnDisplayItem 已挡本地/直播
// 行——分支以落盘消息为终点，在途内容无权威边界）。分支成功即切进新会话
//（selectSingle → single watch 加载历史 + 滚底）；失败静默（服务方法已 warn）。
const clientCtx = useClientContext();
async function forkFromMessage(msgId: string) {
  if (!isSingle.value || !props.single || chatStore.contextBusy) return;
  await clientCtx?.get('singleBoard')?.fork(props.single.id, msgId);
}

</script>

<template>
  <div v-if="dialogId" class="chat-view">
    <!-- ═══ 头部（conversation-view-split-plan ②迁 header/ConversationHeader：
         pair 双端点 / 标题+徽标 / 思维链开关 / 席位 / 反馈 chip 悬挂锚）═══ -->
    <ConversationHeader
      :is-pair="isPair"
      :is-group="isGroup"
      :a="props.a"
      :b="props.b"
      :title="title"
      :preset-chip-label="presetChipLabel"
      :owner-data="headerWidgetData"
    />

    <div v-if="!isGroup && !isPair && !wireStoreConnected" class="connection-status">
      <span>[WARN] 连接已断开，正在重连...</span>
    </div>

    <div class="chat-body">
      <div class="chat-main" :class="{ 'composer-centered': isSingleFresh }">
        <!-- 消息区（fresh 开场模式不渲染：空滚动外壳 flex:1 会占满主区把
             输入卡压到底部——开场画面 = 居中的输入卡本身；首条消息后
             isSingleFresh 翻 false 挂载，滚动/装载链路由既有 watch 接管） -->
        <TranscriptList
          v-if="!isSingleFresh"
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
          :can-fork="isSingle"
          @preview-file="handlePreviewFile"
          @regenerate="chatStore.regenerateMessage"
          @delete-message="chatStore.deleteMessage"
          @edit="(msgId: any, newContent: any) => chatStore.editMessage(msgId, newContent)"
          @fork-from-message="forkFromMessage"
        />

        <!-- 任务 dock 列（composer 上方；群视角隐藏——多成员无单一归属桶；
             pair 只读无 composer/dock；single 空会话开场居中布局也无 dock）。
             数据/刷新各卡自理 -->
        <ComposerDock
          v-if="!isGroup && !isPair && !isSingleFresh"
          :agent-id="dockAgentId"
          :conversation-id="dockConversationId"
        />

        <!-- 输入区（单实例条件接线：group = RPC 群发路径；direct/single =
             store.sendMessage 默认路径 + 排队手势；pair 只读无输入）。
             single 空会话：fresh 模式（顶部工作区|预设选择行 + 输入卡，
             整体垂直居中；首条消息后回常规底部布局） -->
        <ChatInput
          v-if="!isPair && !isSingleFresh"
          :disabled="isGroup && groupTurnInProgress"
          :placeholder="isGroup ? (groupTurnInProgress ? 'Agent 回复中...' : '输入消息发送到群聊...') : undefined"
          :on-send="isGroup ? sendGroupMessage : undefined"
          :single="isGroup ? null : (props.single ?? null)"
          :queued-count="isGroup ? 0 : queuedItems.length"
          :on-steer-all-queued="isGroup ? undefined : steerAllQueued"
        />
        <ChatInput
          v-else-if="isSingleFresh"
          fresh
          :single="props.single ?? null"
          :queued-count="queuedItems.length"
          :on-steer-all-queued="steerAllQueued"
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

.chat-body { flex: 1; display: flex; overflow: hidden; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/* ── 新会话开场居中（single 空会话）：消息区不渲染，composer 区块
   垂直居中——视觉焦点聚在"开始会话"这一步 ── */
.chat-main.composer-centered { justify-content: center; }

.connection-status { text-align: center; padding: 6px; font-size: 12px; color: var(--color-warning); background: var(--color-bg-surface); flex-shrink: 0; }
</style>
