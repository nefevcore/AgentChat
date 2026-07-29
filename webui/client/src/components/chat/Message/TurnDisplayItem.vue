<!-- TurnDisplayItem.vue — 统一的对话轮次展示组件 -->
<!-- isSelf = turn.agent_id === activeAgent → 右侧气泡；否则左侧 -->

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

// ── 左右判定 ──
const activeAgent = computed(() => agentStore.activeAgentId);
const isSelf = computed(() => props.turn.agent_id === activeAgent.value);

// ── 发送者信息 ──
const senderAvatar = computed(() => {
  const aid = props.turn.agent_id;
  return aid ? agentStore.getAgentAvatar(aid) || `/api/agents/${encodeURIComponent(aid)}/avatar` : null;
});
const senderName = computed(() => {
  const aid = props.turn.agent_id;
  if (!aid) return undefined;
  if (aid === 'user') return '我';
  return agentStore.getAgentName(aid) || aid;
});

// ── 消息对象 ──
const finalMsg = computed<ChatMessage | null>(() => props.turn.final);
const hasSteps = computed(() => props.turn.steps.length > 0);

// ── 操作权限 ──
const canEdit = computed(() => props.turn.agent_id === 'user');

// ── 流式状态 ──
const isStreaming = computed(() => props.turn.steps.some(s => s.isStreaming));
const hasRunning = computed(() =>
  props.turn.steps.some(s => s.tools.some(t => t.status === 'running'))
);

// ── 思维链折叠 ──
const isExpanded = ref(chatStore.turnInProgress);
watch(() => chatStore.turnInProgress, v => { if (v) isExpanded.value = true; });

function isThinkingStreamingNow(stepIdx: number): boolean {
  if (!isStreaming.value || stepIdx !== props.turn.steps.length - 1) return false;
  const thinking = props.turn.steps[stepIdx].assistant;
  return !thinking.content || thinking.content.trim() === '';
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }
</script>

<template>
  <div class="turn-item" :class="{ 'turn-self': isSelf, 'turn-other': !isSelf }">

    <!-- ═══ 纯文本 Turn（无思考链）═══ -->
    <template v-if="!hasSteps && finalMsg">
      <!-- 自己的纯文本 → AssistantMessage（右侧） -->
      <div v-if="isSelf" class="turn-final">
        <AssistantMessage
          :message="finalMsg" :index="index" :is-streaming="false"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @regenerate="emit('regenerate', finalMsg.id)"
          @delete-message="emit('deleteMessage', finalMsg.id)"
        />
      </div>
      <!-- 用户消息 → UserMessage（可编辑） -->
      <div v-else-if="canEdit" class="turn-final">
        <UserMessage
          :message="finalMsg" :index="index"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @edit="(id: any, c: any) => emit('edit', id, c)"
        />
      </div>
      <!-- 其他 Agent 的消息 → AssistantMessage（左侧，无操作按钮） -->
      <div v-else class="turn-final">
        <AssistantMessage
          :message="finalMsg" :index="index" :is-streaming="false"
          :sender-avatar="senderAvatar" :sender-name="senderName"
        />
      </div>
    </template>

    <!-- ═══ 含思考链的 Turn ═══ -->
    <template v-if="hasSteps">
      <!-- 思考链折叠栏 -->
      <div class="chain-header" :class="{ 'chain-streaming': isStreaming && hasRunning }"
        @click="toggleExpand()">
        <svg class="chain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a6 6 0 0 1 6 6c0 2.5-1.8 5.5-3.4 6.4a2.5 2.5 0 0 0-1.6 1.6A7 7 0 0 1 12 22a7 7 0 0 1-1-13.9A6 6 0 0 1 12 2z"/>
          <path d="M12 16v4"/><path d="M8 16v4"/><path d="M10 18h4"/>
        </svg>
        <span class="chain-label">思考过程（共 {{ turn.steps.length }} 步）</span>
        <span v-if="isStreaming && hasRunning" class="streaming-dots">
          <span class="dot dot-yellow" /><span class="dot dot-gray" /><span class="dot dot-gray" />
        </span>
        <svg class="collapse-chevron" :class="{ 'chevron-expanded': isExpanded }"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6"/>
        </svg>
      </div>

      <!-- 展开的思考链 -->
      <div v-show="isExpanded" class="chain-body">
        <template v-for="(step, sIdx) in turn.steps" :key="`${index}-${sIdx}`">
          <div class="chain-step">
            <AssistantMessage
              :message="step.assistant" :index="index + sIdx"
              :is-streaming="isThinkingStreamingNow(sIdx)"
              :show-copy="false" compact
            />
          </div>
          <div v-for="(tool, tIdx) in step.tools" :key="`${index}-${sIdx}-${tIdx}`" class="chain-tool">
            <ToolMessage :message="tool" :index="index + sIdx + tIdx + 1" />
          </div>
        </template>
      </div>

      <!-- 最终回复 -->
      <div v-if="finalMsg" class="turn-final">
        <AssistantMessage
          :message="finalMsg" :index="index + turn.steps.length" :is-streaming="false"
          :sender-avatar="isSelf ? senderAvatar : null"
          :sender-name="isSelf ? senderName : undefined"
          @regenerate="emit('regenerate', finalMsg.id)"
          @delete-message="emit('deleteMessage', finalMsg.id)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.turn-item {
  display: flex; flex-direction: column; gap: 6px;
  padding: 0 16px;
}
.turn-other { align-items: flex-start; max-width: 85%; }
.turn-self  { align-items: flex-end;   max-width: 85%; margin-left: auto; }
.turn-final { width: 100%; }

/* ── 思考链头部 ── */
.chain-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; font-weight: 500;
  color: var(--color-text-secondary);
  user-select: none; cursor: pointer; padding: 2px 0;
  transition: color 0.15s;
}
.chain-header:hover, .chain-streaming .chain-label { color: var(--color-text-primary); }
.chain-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--color-text-secondary); }
.chain-label { font-weight: 500; }

/* 流式动画点 */
.streaming-dots { display: inline-flex; align-items: center; gap: 2px; }
.dot { width: 4px; height: 4px; border-radius: 50%; animation: dot-pulse 1.4s infinite ease-in-out; }
.dot-yellow { background: #e6a817; animation-delay: 0s; }
.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes dot-pulse { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }

.collapse-chevron {
  width: 14px; height: 14px; flex-shrink: 0;
  transition: transform 0.2s ease;
  color: var(--color-text-tertiary, #a8abb2);
}
.chevron-expanded { transform: rotate(90deg); }

/* ── 思考链内容 ── */
.chain-body {
  display: flex; flex-direction: column; gap: 6px;
  width: 100%; border-left: 1px solid var(--color-border-secondary);
  padding-left: 14px; margin-left: 7px;
}
</style>
