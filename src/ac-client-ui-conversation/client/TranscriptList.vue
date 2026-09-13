<!-- TranscriptList.vue —— 会话消息区统一组件（会话区重构 B 路线抽取）
  原 DialogView / PairDialogView 各持一份的「滚动容器 + 分隔符 + 逐轮渲染 +
  回到底部 + 空态/加载指示」整块收拢单源；四视角（direct/group/single/
  pair·readonly）共用。滚动外壳（useChatShell）随容器住在本地——宿主经
  defineExpose 拿 scrollToBottom/reset/container（发送后滚底、切换会话重置、
  历史前插滚动补偿需要容器元素）。
  空态 gate：无消息 && 首载未回（firstLoadPending）→ 加载占位而非「开始
  对话」——首开有历史的会话不再被误导成空白新会话。 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatRelativeTime } from './format.ts';
import { useChatShell } from './useChatShell.ts';
import type { DisplayItem } from './types.ts';
import TurnDisplayItem from './Message/TurnDisplayItem.vue';

const props = defineProps<{
  /** 渲染管线产物（useTurnDisplayItems） */
  items: DisplayItem[];
  /** 消息总数（空态 gate；滚动信号之一） */
  messageCount: number;
  /** 流式尾部长度（滚动跟随信号——流式期间不判「用户上翻」） */
  streamingTailLen: number;
  /** 上翻阈值回调（宿主编排历史加载：direct 续拉 / group·pair 前插） */
  onTopThreshold: () => void;
  /** 顶部加载指示（续拉/加载进行中；空态时由加载占位承担，避免双重提示） */
  loading: boolean;
  /** 首载未回（无消息且加载中 → 加载占位） */
  firstLoadPending: boolean;
  /** 空态文案（形态各异，宿主供） */
  emptyText: string;
  /** 轮内操作（regenerate/edit/…；group 与 readonly 形态传 false） */
  showActions: boolean;
  /** 左右对齐基准（用户消息靠右——镜像 TurnDisplayItem 同名 prop，透传） */
  settingsAgentId: string;
  /** 所在会话键（M32 文件预览工作区推导；透传 TurnDisplayItem） */
  conversationId?: string;
}>();

const emit = defineEmits<{
  (e: 'preview-file', payload: string | { filePath: string; agentId?: string; conversationId?: string }): void;
  (e: 'regenerate', msgId: string): void;
  (e: 'delete-message', msgId: string): void;
  (e: 'edit', msgId: string, newContent: string): void;
}>();

const messagesContainer = ref<HTMLElement>();

// ── 滚动外壳（统一四形态；signal = 消息数 + 流式尾长）──
const shell = useChatShell({
  container: messagesContainer,
  onTopThreshold: () => props.onTopThreshold(),
  signal: () => [props.messageCount, props.streamingTailLen] as const,
});
const isUserScrolledUp = computed(() => shell.isUserScrolledUp.value);

/** 宿主面：发送后滚底 / 切换会话重置闭包态 / 历史前插滚动补偿取容器 */
defineExpose({
  scrollToBottom: () => shell.scrollToBottom(),
  reset: () => shell.reset(),
  container: () => messagesContainer.value,
});
</script>

<template>
  <div class="messages-wrapper">
    <div ref="messagesContainer" class="messages-container" @scroll="shell.onScroll">
      <div class="messages-content">
        <!-- 空态 gate（首载未回 = 加载占位，不显示「开始对话」） -->
        <div v-if="messageCount === 0" class="empty-state">
          <template v-if="firstLoadPending">
            <span class="history-spinner empty-state-spinner"></span>
            <p>正在加载历史消息…</p>
          </template>
          <template v-else>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>{{ emptyText }}</p>
          </template>
        </div>

        <!-- 加载更多历史消息指示器（空态时由上方加载占位承担） -->
        <div v-if="messageCount > 0 && loading" class="history-loading">
          <span class="history-spinner"></span>
          <span class="history-loading-text">加载历史消息中…</span>
        </div>

        <template v-for="(item, idx) in items" :key="item.key ?? `${item.type}-${idx}`">
          <div v-if="item.type === 'time-separator'" class="time-separator">
            <span class="time-separator-text">{{ item.timeText }}</span>
          </div>
          <div v-else-if="item.type === 'event'" class="event-separator" :class="{ 'event-separator--inline': item.midRun }">
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
            :settings-agent-id="settingsAgentId"
            :show-actions="showActions"
            :continuation="item.continuation"
            :conversation-id="conversationId"
            @regenerate="emit('regenerate', $event)"
            @delete-message="emit('delete-message', $event)"
            @edit="(msgId: any, newContent: any) => emit('edit', msgId, newContent)"
            @preview-file="emit('preview-file', $event)"
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
</template>

<style scoped>
/* 消息区 */
.messages-wrapper { flex: 1; position: relative; overflow: hidden; }
.messages-container { height: 100%; overflow-y: auto; overflow-x: hidden; padding: var(--space-md); scrollbar-width: thin; scrollbar-color: transparent transparent; }
.messages-content { display: flex; flex-direction: column; gap: var(--space-sm); width: 100%; max-width: 100%; margin: 0 auto; min-height: 100%; }
/* 滚动条仅悬停会话区域时可见：默认拇指透明（6px 槽位常驻，避免悬停时内容宽度跳变） */
.messages-container:hover { scrollbar-color: var(--color-border-primary) transparent; }
.messages-container::-webkit-scrollbar { width: 6px; }
.messages-container::-webkit-scrollbar-track { background: transparent; }
.messages-container::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }
.messages-container:hover::-webkit-scrollbar-thumb { background: var(--color-border-primary); }
.messages-container::-webkit-scrollbar-thumb:hover { background: var(--color-primary); }

.empty-state { text-align: center; padding: 40px; color: var(--color-text-muted); }
.empty-state svg { margin-bottom: 12px; }
.empty-state p { font-size: 15px; }

.time-separator { display: flex; align-items: center; justify-content: center; user-select: none; }
.time-separator-text { font-size: 12px; color: var(--color-text-muted, #999); padding: 2px 12px; letter-spacing: 0.5px; }
.event-separator { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; user-select: none; width: 100%; max-width: 720px; margin: 4px auto; padding-left: 42px; padding-right: 42px; }
/* run 中插播事件（前后均為同 agent 轮）：紧凑居中——文字直接复用下方通用
   .event-separator-text（无背景/边框，与时间分隔控件同视觉，只要文字）；
   仅保留行距与时间隐藏，弱化对阅读流的切断感 */
.event-separator--inline { margin: 1px auto; padding: 0 12px; }
.event-separator--inline .event-separator-time { display: none; }
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

@media (max-width: 768px) {
  .messages-container { padding: var(--space-sm); }
  .scroll-to-bottom-btn { right: 12px; bottom: 12px; }
}
</style>
