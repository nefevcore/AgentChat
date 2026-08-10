<!-- UserMessage.vue —— 用户消息气泡 -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ChatMessage, FileAttachment } from '@/domain/types';
import { useMarkdown } from '@/composables/useMarkdown';
import { formatFileSize } from '@/domain/format';

const props = defineProps<{
  message: ChatMessage;
  index: number;
  senderAvatar?: string | null;
  senderName?: string;
}>();

const emit = defineEmits<{
  edit: [msgId: string, newContent: string];
  previewFile: [filePath: string];
}>();

const { render } = useMarkdown();
const isEditing = ref(false);
const editText = ref('');

function startEdit() {
  editText.value = props.message.content || '';
  isEditing.value = true;
}
function cancelEdit() { isEditing.value = false; }
function saveEdit() {
  emit('edit', props.message.id, editText.value);
  isEditing.value = false;
}

const rendered = computed(() => render(props.message.content || ''));
</script>

<template>
  <div class="user-message">
    <div class="user-bubble">
      <div v-if="isEditing" class="edit-box">
        <textarea v-model="editText" class="edit-textarea" rows="3" />
        <div class="edit-actions">
          <button class="edit-btn primary" @click="saveEdit">保存</button>
          <button class="edit-btn" @click="cancelEdit">取消</button>
        </div>
      </div>
      <template v-else>
        <div class="user-content" v-html="rendered" />
        <div v-if="message.files?.length" class="file-chips">
          <span v-for="f in message.files" :key="f.hash" class="file-chip">
            📎 {{ f.filename }} ({{ formatFileSize(f.filesize) }})
          </span>
        </div>
        <button class="edit-hint" @click="startEdit" title="编辑消息">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.user-message { display: flex; justify-content: flex-end; }
.user-bubble {
  position: relative;
  max-width: 100%;
  background: var(--color-primary-soft, rgba(99, 102, 241, 0.18));
  border-radius: 12px;
  padding: 8px 12px;
}
.user-content :deep(p) { margin: 0; }
.user-content :deep(pre) { background: var(--color-bg-code, rgba(0, 0, 0, 0.3)); border-radius: 6px; padding: 8px; overflow-x: auto; }
.user-content :deep(code) { font-size: 13px; }
.user-content :deep(a) { color: var(--color-primary, #6366f1); }
.file-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.file-chip { font-size: 12px; background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); padding: 2px 8px; border-radius: 6px; }
.edit-hint {
  position: absolute; top: 6px; right: 6px;
  border: none; background: transparent; color: var(--color-text-tertiary, #a8abb2);
  cursor: pointer; opacity: 0; transition: opacity 0.15s; padding: 2px;
}
.user-bubble:hover .edit-hint { opacity: 1; }
.edit-box { display: flex; flex-direction: column; gap: 6px; min-width: 320px; }
.edit-textarea {
  resize: vertical; border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  border-radius: 6px; padding: 8px; background: var(--color-bg-input, rgba(255, 255, 255, 0.04));
  color: var(--color-text-primary); font-size: 13px; font-family: inherit;
}
.edit-actions { display: flex; gap: 6px; justify-content: flex-end; }
.edit-btn {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  background: transparent; color: var(--color-text-secondary);
  border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.edit-btn.primary { background: var(--color-primary, #6366f1); color: #fff; border-color: transparent; }
</style>
