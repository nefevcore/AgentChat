<!-- AssistantMessage.vue —— Agent 回复气泡 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';
import TypingIndicator from './TypingIndicator.vue';
import type { ChatMessage, FileAttachment } from '@/domain/types';
import { formatFileSize } from '@/domain/format';

const props = withDefaults(defineProps<{
  message: ChatMessage;
  index: number;
  isStreaming?: boolean;
  showCopy?: boolean;
  showActions?: boolean;
  compact?: boolean;
  senderAvatar?: string | null;
  senderName?: string;
}>(), {
  showCopy: true,
  showActions: true,
  compact: false,
});

const emit = defineEmits<{
  downloadFile: [file: FileAttachment];
  previewFile: [filePath: string];
  regenerate: [];
  deleteMessage: [];
}>();

const { render, renderPlain } = useMarkdown();

function renderContent() { return render(props.message.content || ''); }
function renderReasoning() {
  const rc = props.message.reasoning_content || props.message.thinking || '';
  if (!rc.trim()) return '';
  return renderPlain(rc);
}

const hasThinking = computed(() => {
  const rc = props.message.reasoning_content || props.message.thinking || '';
  return rc.trim().length > 0;
});
const hasOnlyThinking = computed(() => hasThinking.value && (!props.message.content || props.message.content.trim() === ''));
const hasContent = computed(() => !!(props.message.content && props.message.content.trim().length > 0));

const copyFeedback = ref(false);
function copyText() {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(props.message.content || '').then(() => {
      copyFeedback.value = true;
      setTimeout(() => { copyFeedback.value = false; }, 1500);
    });
  }
}
</script>

<template>
  <div class="assistant-message" :class="{ compact }">
    <div v-if="!compact && senderAvatar" class="avatar">
      <img v-if="senderAvatar.startsWith('data:') || senderAvatar.startsWith('http') || senderAvatar.startsWith('/')" :src="senderAvatar" class="avatar-img" alt="" />
    </div>
    <div class="assistant-body">
      <div v-if="!compact && senderName" class="sender-name">{{ senderName }}</div>

      <!-- 思维链（折叠区） -->
      <div v-if="hasThinking && !hasOnlyThinking" class="thinking-block">
        <details class="thinking-details" open>
          <summary class="thinking-summary">
            <span class="thinking-label">{{ props.message.label || '思考过程' }}</span>
            <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <pre class="thinking-content">{{ renderReasoning() }}</pre>
        </details>
      </div>

      <!-- 正文 -->
      <div v-if="hasContent" class="assistant-bubble">
        <div class="assistant-content" v-html="renderContent()" />
        <div v-if="message.files?.length" class="file-chips">
          <span v-for="f in message.files" :key="f.hash" class="file-chip">📎 {{ f.filename }} ({{ formatFileSize(f.filesize) }})</span>
        </div>
        <div v-if="props.isStreaming" class="typing-cursor" />
        <div v-else-if="showActions && !compact" class="action-row">
          <button class="action-btn" title="复制" @click="copyText">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          </button>
          <button class="action-btn" title="重新推理" @click="emit('regenerate')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>
          </button>
          <button class="action-btn danger" title="删除" @click="emit('deleteMessage')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          </button>
        </div>
        <span v-if="copyFeedback" class="copy-feedback">已复制</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant-message { display: flex; gap: 10px; align-items: flex-start; }
.assistant-message.compact { gap: 6px; }
.avatar { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; flex-shrink: 0; background: var(--color-bg-hover, rgba(255, 255, 255, 0.08)); }
.avatar-img { width: 100%; height: 100%; object-fit: cover; }
.assistant-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sender-name { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); }
.thinking-block { margin-bottom: 2px; }
.thinking-details { border-left: 2px solid var(--color-border, rgba(255, 255, 255, 0.12)); padding-left: 10px; }
.thinking-summary {
  display: flex; align-items: center; gap: 4px;
  cursor: pointer; list-style: none;
  font-size: 12px; color: var(--color-text-tertiary, #a8abb2);
  user-select: none;
}
.thinking-summary::-webkit-details-marker { display: none; }
.chevron { transition: transform 0.2s; }
.thinking-details[open] .chevron { transform: rotate(180deg); }
.thinking-content {
  font-size: 12px; color: var(--color-text-tertiary, #a8abb2);
  white-space: pre-wrap; word-break: break-word;
  margin-top: 4px; font-family: inherit;
}
.assistant-bubble { position: relative; }
.assistant-content { font-size: 14px; line-height: 1.7; color: var(--color-text-primary); word-break: break-word; }
.assistant-content :deep(p) { margin: 0 0 8px; }
.assistant-content :deep(p:last-child) { margin-bottom: 0; }
.assistant-content :deep(pre) { background: var(--color-bg-code, rgba(0, 0, 0, 0.35)); border-radius: 8px; padding: 10px; overflow-x: auto; margin: 8px 0; }
.assistant-content :deep(code) { font-size: 13px; font-family: 'Cascadia Code', Consolas, monospace; }
.assistant-content :deep(a) { color: var(--color-primary, #6366f1); }
.assistant-content :deep(table) { border-collapse: collapse; }
.assistant-content :deep(th), .assistant-content :deep(td) { border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15)); padding: 4px 8px; }
.file-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.file-chip { font-size: 12px; background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); padding: 2px 8px; border-radius: 6px; }
.typing-cursor {
  display: inline-block; width: 2px; height: 16px;
  background: var(--color-primary, #6366f1);
  animation: blink 1s step-start infinite;
  vertical-align: text-bottom; margin-left: 2px;
}
@keyframes blink { 50% { opacity: 0; } }
.action-row { display: flex; gap: 4px; margin-top: 6px; opacity: 0; transition: opacity 0.15s; }
.assistant-bubble:hover .action-row { opacity: 1; }
.action-btn {
  width: 24px; height: 24px;
  border: none; border-radius: 5px; background: transparent;
  color: var(--color-text-tertiary, #a8abb2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.action-btn:hover { background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); color: var(--color-text-primary); }
.action-btn.danger:hover { color: #e74c3c; }
.copy-feedback {
  position: absolute; top: 0; right: 0;
  font-size: 11px; color: var(--color-primary, #6366f1);
}
</style>
