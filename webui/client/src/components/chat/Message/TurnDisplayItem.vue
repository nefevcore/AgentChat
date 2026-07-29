<!-- TurnDisplayItem.vue — 统一对话轮次 -->
<!-- 左: agent_id !== activeAgent  |  右: agent_id === activeAgent -->

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useAgentStore } from '@/stores/agents';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import UserMessage from './UserMessage.vue';
import type { Turn, ChatMessage } from '@/types';

const props = defineProps<{ turn: Turn; index: number }>();

const emit = defineEmits<{
  regenerate: [msgId: string];
  deleteMessage: [msgId: string];
  edit: [msgId: string, newContent: string];
  continueGeneration: [];
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();

const activeAgent = computed(() => agentStore.activeAgentId);
const isSelf = computed(() => props.turn.agent_id === activeAgent.value);
const finalMsg = computed<ChatMessage | null>(() => props.turn.final);
const hasSteps = computed(() => props.turn.steps.length > 0);
const canEdit = computed(() => props.turn.agent_id === 'user');

// 发送者信息（仅左侧用）
const senderAvatar = computed(() => {
  const aid = props.turn.agent_id;
  return aid ? agentStore.getAgentAvatar(aid) || `/api/agents/${encodeURIComponent(aid)}/avatar` : null;
});
const senderName = computed(() => {
  const aid = props.turn.agent_id;
  if (!aid) return undefined;
  return agentStore.getAgentName(aid) || aid;
});

const isStreaming = computed(() => props.turn.steps.some(s => s.isStreaming));
const hasRunning = computed(() => props.turn.steps.some(s => s.tools.some(t => t.status === 'running')));
const isExpanded = ref(chatStore.turnInProgress);
watch(() => chatStore.turnInProgress, v => { if (v) isExpanded.value = true; });

function isThinkingStreamingNow(sIdx: number) {
  if (!isStreaming.value || sIdx !== props.turn.steps.length - 1) return false;
  return !props.turn.steps[sIdx].assistant.content?.trim();
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }
</script>

<template>
  <div class="turn-item" :class="isSelf ? 'turn-right' : 'turn-left'">

    <!-- ═══ 纯文本 ═══ -->
    <template v-if="!hasSteps && finalMsg">
      <!-- 右侧：自己的消息 -->
      <div v-if="isSelf" class="bubble-right">
        <AssistantMessage
          :message="finalMsg" :index="index" :is-streaming="false"
          @regenerate="emit('regenerate', finalMsg.id)"
          @delete-message="emit('deleteMessage', finalMsg.id)"
        />
      </div>
      <!-- 左侧：他人消息 -->
      <div v-else class="bubble-left">
        <UserMessage
          :message="finalMsg" :index="index"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @edit="canEdit ? (id: any, c: any) => emit('edit', id, c) : undefined"
        />
      </div>
    </template>

    <!-- ═══ 含思考链 ═══ -->
    <template v-if="hasSteps">
      <div class="chain-header" :class="{ 'chain-streaming': isStreaming && hasRunning }" @click="toggleExpand">
        <svg class="chain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a6 6 0 0 1 6 6c0 2.5-1.8 5.5-3.4 6.4a2.5 2.5 0 0 0-1.6 1.6A7 7 0 0 1 12 22a7 7 0 0 1-1-13.9A6 6 0 0 1 12 2z"/>
          <path d="M12 16v4"/><path d="M8 16v4"/><path d="M10 18h4"/>
        </svg>
        <span class="chain-label">思考过程（共 {{ turn.steps.length }} 步）</span>
        <span v-if="isStreaming && hasRunning" class="streaming-dots">
          <span class="dot dot-yellow" /><span class="dot dot-gray" /><span class="dot dot-gray" />
        </span>
        <svg class="collapse-chevron" :class="{ expanded: isExpanded }"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6"/>
        </svg>
      </div>

      <div v-show="isExpanded" class="chain-body">
        <template v-for="(step, sIdx) in turn.steps" :key="`${index}-${sIdx}`">
          <AssistantMessage
            :message="step.assistant" :index="index + sIdx"
            :is-streaming="isThinkingStreamingNow(sIdx)" :show-copy="false" compact
          />
          <ToolMessage
            v-for="(tool, tIdx) in step.tools" :key="`${index}-${sIdx}-${tIdx}`"
            :message="tool" :index="index + sIdx + tIdx + 1"
          />
        </template>
      </div>

      <!-- 最终回复 -->
      <div v-if="finalMsg" :class="isSelf ? 'bubble-right' : 'bubble-left'">
        <AssistantMessage
          :message="finalMsg" :index="index + turn.steps.length" :is-streaming="false"
          @regenerate="isSelf ? emit('regenerate', finalMsg.id) : undefined"
          @delete-message="isSelf ? emit('deleteMessage', finalMsg.id) : undefined"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.turn-item { display: flex; flex-direction: column; gap: 8px; }

/* ── 左右位置 ── */
.turn-left  { align-items: flex-start; max-width: 85%; }
.turn-right { align-items: flex-end;   max-width: 85%; margin-left: auto; }
.bubble-left  { max-width: 75%; }
.bubble-right { max-width: 75%; }

/* 右侧气泡：翻转 AssistantMessage 内部的对齐方向 */
.turn-right :deep(.message-assistant) { align-items: flex-end; }
.turn-right :deep(.assistant-message) { flex-direction: row-reverse; }
.turn-right :deep(.sender-name) { text-align: right; }
.turn-right :deep(.msg-avatar) { align-self: flex-end; }

/* ── 思考链头部 ── */
.chain-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; font-weight: 500;
  color: var(--color-text-secondary);
  user-select: none; cursor: pointer; padding: 2px 0; transition: color 0.15s;
}
.chain-header:hover, .chain-streaming .chain-label { color: var(--color-text-primary); }
.chain-icon, .collapse-chevron { width: 14px; height: 14px; flex-shrink: 0; color: var(--color-text-secondary); }
.chain-label { font-weight: 500; }

.streaming-dots { display: inline-flex; align-items: center; gap: 2px; }
.dot { width: 4px; height: 4px; border-radius: 50%; animation: dot-pulse 1.4s infinite ease-in-out; }
.dot-yellow { background: #e6a817; }
.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes dot-pulse { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }

.collapse-chevron { transition: transform 0.2s ease; color: var(--color-text-tertiary, #a8abb2); }
.expanded { transform: rotate(90deg); }

.chain-body {
  display: flex; flex-direction: column; gap: 6px;
  width: 100%; border-left: 1px solid var(--color-border-secondary);
  padding-left: 14px; margin-left: 7px;
}
</style>
