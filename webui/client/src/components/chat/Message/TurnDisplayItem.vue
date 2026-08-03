<!-- TurnDisplayItem.vue — 统一对话轮次 -->
<!-- 右 = settingsAgentId 的消息；左 = 其他 -->

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useAgentStore } from '@/stores/agents';
import { VIEWER_ID } from '@/constants';
import AssistantMessage from './AssistantMessage.vue';
import ToolMessage from './ToolMessage.vue';
import UserMessage from './UserMessage.vue';
import type { Turn, ChatMessage } from '@/types';

const props = defineProps<{ turn: Turn; index: number; settingsAgentId: string }>();

const emit = defineEmits<{
  regenerate: [msgId: string];
  deleteMessage: [msgId: string];
  edit: [msgId: string, newContent: string];
  continueGeneration: [];
  previewFile: [filePath: string];
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();

const isSelf = computed(() => props.turn.agent_id === props.settingsAgentId);
const finalMsg = computed<ChatMessage | null>(() => props.turn.final);

const meaningfulSteps = computed(() =>
  props.turn.steps.filter(s =>
    (s.assistant.thinking || s.assistant.reasoning_content || '').trim()
    || s.tools.length > 0
  )
);

const hasChain = computed(() => meaningfulSteps.value.length > 0);

const stepCount = computed(() => meaningfulSteps.value.length);

const chainLabel = computed(() => {
  const cnt = meaningfulSteps.value.length;
  const first = meaningfulSteps.value[0];
  const last = meaningfulSteps.value[cnt - 1];
  const firstTs = first?.assistant?.timestamp ?? first?.tools?.[0]?.timestamp ?? 0;
  const lastTs = last?.assistant?.timestamp ?? last?.tools?.at(-1)?.timestamp ?? 0;
  let elapsed = firstTs && lastTs ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0;
  // 时间戳推导为 0 时，从各 step 的 label（如 "已思考（用时 12 秒）"）中累加
  if (elapsed === 0 && cnt > 0) {
    for (const s of meaningfulSteps.value) {
      const m = ((s.assistant as any).label || '').match(/用时\s*([\d.]+)\s*秒/);
      if (m) elapsed += parseFloat(m[1]);
    }
  }
  const parts = [`共 ${cnt} 步`];
  if (elapsed > 0) parts.push(`共用时 ${Math.round(elapsed)} 秒`);
  const label = `思考过程（${parts.join('，')}）`;
  return label;
});

const canEdit = computed(() => props.turn.agent_id === VIEWER_ID.value);

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
const wasStreaming = ref(false);
// 流式过程中保持展开，不随单步结束逐个折叠（避免展开→折叠→展开的闪烁）
// immediate：组件在流式中创建时 isStreaming 初始即为 true，需立即标记 wasStreaming
watch(isStreaming, (v) => {
  if (v) {
    wasStreaming.value = true;
    isExpanded.value = true;
  }
}, { immediate: true });
// 会话整体结束时一次性折叠所有思维链（仅折叠本次会话经历流式的 turn，
// 不影响历史 turn 和用户手动展开的）
watch(() => chatStore.turnInProgress, (v) => {
  if (!v && wasStreaming.value) {
    wasStreaming.value = false;
    isExpanded.value = false;
  }
});


function isThinkingStreamingNow(sIdx: number) {
  if (!isStreaming.value || sIdx !== meaningfulSteps.value.length - 1) return false;
  return !meaningfulSteps.value[sIdx].assistant.content?.trim();
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }
</script>

<template>
  <div class="turn-item" :class="isSelf ? 'turn-right' : 'turn-left'">

    <!-- ═══ 纯文本 ═══ -->
    <template v-if="!hasChain && finalMsg">
      <div v-if="isSelf" class="turn-bubble turn-bubble-right">
        <UserMessage
          :message="finalMsg" :index="index"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @edit="canEdit ? (id: any, c: any) => emit('edit', id, c) : undefined"
          @preview-file="(fp: string) => emit('previewFile', fp)"
        />
      </div>
      <div v-else class="turn-bubble turn-bubble-left">
        <AssistantMessage
          :message="finalMsg" :index="index" :is-streaming="false"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @preview-file="(fp: string) => emit('previewFile', fp)"
        />
      </div>
    </template>

    <!-- ═══ 含折叠栏 ═══ -->
    <template v-if="hasChain">
      <div class="chain-header" :class="{ 'chain-streaming': isStreaming && hasRunning }" @click="toggleExpand">
        <svg class="chain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a6 6 0 0 1 6 6c0 2.5-1.8 5.5-3.4 6.4a2.5 2.5 0 0 0-1.6 1.6A7 7 0 0 1 12 22a7 7 0 0 1-1-13.9A6 6 0 0 1 12 2z"/>
          <path d="M12 16v4"/><path d="M8 16v4"/><path d="M10 18h4"/>
        </svg>
        <span class="chain-label">{{ chainLabel }}</span>
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
        <template v-for="(step, sIdx) in meaningfulSteps" :key="`${index}-${sIdx}`">
          <AssistantMessage
            :message="{ ...step.assistant, content: '', toolCalls: [] }" :index="index + sIdx"
            :is-streaming="isThinkingStreamingNow(sIdx)" :show-copy="false" compact
            @preview-file="(fp: string) => emit('previewFile', fp)"
          />
          <ToolMessage
            v-for="(tool, tIdx) in step.tools" :key="`${index}-${sIdx}-${tIdx}`"
            :message="tool" :index="index + sIdx + tIdx + 1"
          />
          <div v-if="step.assistant.content?.trim() && step.assistant.content !== finalMsg?.content" class="chain-step-content">
            <!-- 修复：正文展示以「是否等于 final 气泡正文」为准，而非「是否最后一条 meaningful step」。
                 当 entry 末尾有纯文本消息（无 thinking）时，最后一条 meaningful step 的正文
                 既不是 final（final=末尾纯文本），也不应被吞掉，需在此展示。 -->
            <AssistantMessage
              :message="{ ...step.assistant, thinking: '', reasoning_content: '', toolCalls: [] }"
              :index="index + sIdx" :show-copy="false" compact
              @preview-file="(fp: string) => emit('previewFile', fp)"
            />
          </div>
        </template>
      </div>

      <div v-if="finalMsg" :class="isSelf ? 'turn-bubble turn-bubble-right' : 'turn-bubble turn-bubble-left'">
        <AssistantMessage
          :message="finalMsg" :index="index + stepCount" :is-streaming="false"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          @preview-file="(fp: string) => emit('previewFile', fp)"
          @regenerate="isSelf ? emit('regenerate', finalMsg.id) : undefined"
          @delete-message="isSelf ? emit('deleteMessage', finalMsg.id) : undefined"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.turn-item { display: flex; flex-direction: column; gap: 8px; max-width: 70%; }
.turn-left  { align-items: flex-start; }
.turn-right { align-items: flex-end;   margin-left: auto; }
.turn-bubble { width: 100%; }







.turn-bubble-right :deep(.message-assistant) { align-items: flex-end !important; }
.turn-bubble-right :deep(.assistant-message) { flex-direction: row-reverse !important; }
.turn-bubble-right :deep(.sender-name) { text-align: right !important; }

/* 气泡内文本换行 */
.turn-bubble :deep(.assistant-content) { min-width: 0 !important; }
.turn-bubble :deep(.assistant-bubble) { overflow-wrap: break-word !important; word-break: break-word !important; }

.chain-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; font-weight: 500;
  color: var(--color-text-secondary);
  user-select: none; cursor: pointer; padding: 2px 0 2px 46px; transition: color 0.15s;
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
  width: calc(100% - 52px); border-left: 1px solid var(--color-border-secondary);
  margin-left: 52px; padding: 0 0 0 16px;
}
.chain-body :deep(.assistant-message) { max-width: 100% !important; }

/* chain-step-content 在 chain-body 内部，无需额外缩进 */
.chain-step-content {
  display: flex; flex-direction: column; gap: 6px;
}
</style>
