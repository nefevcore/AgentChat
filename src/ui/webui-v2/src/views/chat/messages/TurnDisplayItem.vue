<!-- TurnDisplayItem.vue —— 统一对话轮次
     通过消息渲染插槽分发 User/Assistant/Tool/Trigger，
     自身只负责：左右对齐、思维链折叠、动作转发。
     新增消息类型无需改动本文件（注册到插槽即可）。 -->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useAgentStore } from '@/stores/agents';
import { VIEWER_ID } from '@/stores/agents';
import { getMessageView } from '@/framework/messageViews';
import type { Turn, ChatMessage } from '@/domain/types';

const props = defineProps<{
  turn: Turn;
  index: number;
  showActions?: boolean;
}>();

const emit = defineEmits<{
  regenerate: [msgId: string];
  deleteMessage: [msgId: string];
  edit: [msgId: string, newContent: string];
  continueGeneration: [];
  previewFile: [filePath: string];
}>();

const chatStore = useChatStore();
const agentStore = useAgentStore();

const isSelf = computed(() => props.turn.agent_id === VIEWER_ID);
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
  if (elapsed === 0 && cnt > 0) {
    for (const s of meaningfulSteps.value) {
      const m = ((s.assistant as any).label || '').match(/用时\s*([\d.]+)\s*秒/);
      if (m) elapsed += parseFloat(m[1]);
    }
  }
  const parts = [`共 ${cnt} 步`];
  if (elapsed > 0) parts.push(`共用时 ${Math.round(elapsed)} 秒`);
  return `思考过程（${parts.join('，')}）`;
});

const canEdit = computed(() => props.turn.agent_id === VIEWER_ID);

const senderAvatar = computed(() => {
  const aid = props.turn.agent_id;
  if (!aid) return null;
  return agentStore.getAgentAvatar(aid) || `/api/agents/${encodeURIComponent(aid)}/avatar`;
});
const senderName = computed(() => {
  const aid = props.turn.agent_id;
  return aid ? (agentStore.getAgentName(aid) || aid) : undefined;
});

const isStreaming = computed(() => props.turn.steps.some(s => s.isStreaming));
const hasRunning = computed(() => props.turn.steps.some(s => s.tools.some(t => t.status === 'running')));
const isExpanded = ref(chatStore.turnInProgress);
const wasStreaming = ref(false);

watch(isStreaming, (v) => {
  if (v) { wasStreaming.value = true; isExpanded.value = true; }
}, { immediate: true });
watch(() => chatStore.turnInProgress, (v) => {
  if (!v && wasStreaming.value) { wasStreaming.value = false; isExpanded.value = false; }
});

function isThinkingStreamingNow(sIdx: number) {
  if (!isStreaming.value || sIdx !== meaningfulSteps.value.length - 1) return false;
  return !meaningfulSteps.value[sIdx].assistant.content?.trim();
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }

// 通过插槽获取消息视图组件
const UserView = getMessageView('user');
const AssistantView = getMessageView('assistant');
const ToolView = getMessageView('tool');
const TriggerView = getMessageView('trigger');
</script>

<template>
  <div class="turn-item" :class="isSelf ? 'turn-right' : 'turn-left'">
    <!-- ═══ 纯文本（无思维链）═══ -->
    <template v-if="!hasChain && finalMsg">
      <template v-if="finalMsg.role === 'trigger' && TriggerView">
        <component :is="TriggerView" :message="finalMsg" :index="index" />
      </template>
      <template v-else-if="isSelf && UserView">
        <div class="turn-bubble turn-bubble-right">
          <component
            :is="UserView"
            :message="finalMsg" :index="index"
            :sender-avatar="senderAvatar" :sender-name="senderName"
            @edit="canEdit ? (id: any, c: any) => emit('edit', id, c) : undefined"
            @preview-file="(fp: string) => emit('previewFile', fp)"
          />
        </div>
      </template>
      <template v-else-if="AssistantView">
        <div class="turn-bubble turn-bubble-left">
          <component
            :is="AssistantView"
            :message="finalMsg" :index="index" :is-streaming="false"
            :sender-avatar="senderAvatar" :sender-name="senderName"
            :show-actions="showActions"
            @preview-file="(fp: string) => emit('previewFile', fp)"
          />
        </div>
      </template>
    </template>

    <!-- ═══ 含思维链折叠栏 ═══ -->
    <template v-if="hasChain">
      <div class="chain-header" :class="{ 'chain-streaming': isStreaming && hasRunning }" @click="toggleExpand">
        <svg class="chain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a6 6 0 0 1 6 6c0 2.5-1.8 5.5-3.4 6.4a2.5 2.5 0 0 0-1.6 1.6A7 7 0 0 1 12 22a7 7 0 0 1-1-13.9A6 6 0 0 1 12 2z" /><path d="M12 16v4" /><path d="M8 16v4" /><path d="M10 18h4" /></svg>
        <span class="chain-label">{{ chainLabel }}</span>
        <span v-if="isStreaming && hasRunning" class="streaming-dots">
          <span class="dot dot-yellow" /><span class="dot dot-gray" /><span class="dot dot-gray" />
        </span>
        <svg class="collapse-chevron" :class="{ expanded: isExpanded }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
      </div>

      <div v-show="isExpanded" class="chain-body">
        <template v-for="(step, sIdx) in meaningfulSteps" :key="`${index}-${sIdx}`">
          <AssistantView
            v-if="AssistantView"
            :message="{ ...step.assistant, content: '', toolCalls: [] }" :index="index + sIdx"
            :is-streaming="isThinkingStreamingNow(sIdx)" :show-copy="false" compact
            @preview-file="(fp: string) => emit('previewFile', fp)"
          />
          <ToolView
            v-for="(tool, tIdx) in step.tools" :key="`${index}-${sIdx}-${tIdx}`"
            :message="tool" :index="index + sIdx + tIdx + 1"
          />
          <div v-if="step.assistant.content?.trim() && step.assistant.content !== finalMsg?.content" class="chain-step-content">
            <AssistantView
              v-if="AssistantView"
              :message="{ ...step.assistant, thinking: '', reasoning_content: '', toolCalls: [] }"
              :index="index + sIdx" :show-copy="false" compact
              @preview-file="(fp: string) => emit('previewFile', fp)"
            />
          </div>
        </template>
      </div>

      <div v-if="finalMsg && AssistantView" :class="isSelf ? 'turn-bubble turn-bubble-right' : 'turn-bubble turn-bubble-left'">
        <component
          :is="AssistantView"
          :message="finalMsg" :index="index + stepCount" :is-streaming="false"
          :sender-avatar="senderAvatar" :sender-name="senderName"
          :show-actions="showActions"
          @preview-file="(fp: string) => emit('previewFile', fp)"
          @regenerate="showActions && !isSelf ? emit('regenerate', finalMsg.id) : undefined"
          @delete-message="showActions && !isSelf ? emit('deleteMessage', finalMsg.id) : undefined"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.turn-item { display: flex; flex-direction: column; gap: 8px; max-width: 70%; overflow: hidden; }
.turn-left { align-items: flex-start; }
.turn-right { align-items: flex-end; margin-left: auto; }
.turn-bubble { width: 100%; }
.turn-bubble-right :deep(.message-assistant) { align-items: flex-end !important; }
.turn-bubble-right :deep(.assistant-message) { flex-direction: row-reverse !important; }
.turn-bubble-right :deep(.sender-name) { text-align: right !important; }
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
.streaming-dots { display: inline-flex; align-items: center; gap: 2px; }
.dot { width: 4px; height: 4px; border-radius: 50%; animation: dot-pulse 1.4s infinite ease-in-out; }
.dot-yellow { background: #e6a817; }
.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes dot-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.collapse-chevron { transition: transform 0.2s ease; color: var(--color-text-tertiary, #a8abb2); }
.expanded { transform: rotate(90deg); }
.chain-body { display: flex; flex-direction: column; gap: 8px; padding-left: 46px; }
.chain-step-content { display: flex; flex-direction: column; gap: 8px; }
</style>
