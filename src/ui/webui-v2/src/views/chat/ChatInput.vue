<script setup lang="ts">
import { ref } from 'vue';
import { useChatStore } from '@/stores/chat';
import { useAgentStore } from '@/stores/agents';
import { uploadFile } from '@/services/api';
import type { FileAttachment } from '@/domain/types';
import InteractionBar from './InteractionBar.vue';

const props = defineProps<{
  disabled?: boolean;
  placeholder?: string;
  onSend?: (text: string) => void;
}>();

const store = useChatStore();
const agentStore = useAgentStore();
const inputText = ref('');
const deepThink = ref(true);
const attachedFiles = ref<FileAttachment[]>([]);
const uploading = ref(false);

function send() {
  const text = inputText.value.trim();
  if (!text && attachedFiles.value.length === 0) return;

  if (props.onSend) {
    props.onSend(text);
  } else {
    if (store.conversations[store.activeKey]?.turnInProgress) store.interruptGeneration();
    store.sendMessage(text, attachedFiles.value);
  }

  inputText.value = '';
  attachedFiles.value = [];
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

async function triggerFileUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    const files = input.files;
    if (!files || files.length === 0) return;
    uploading.value = true;
    for (const file of Array.from(files)) {
      try {
        const active = store.activeRef as { kind: 'agent'; id: string } | { kind: 'group'; id: string } | null;
        const curAgent = active && active.kind === 'agent' ? active.id : '';
        const data = await uploadFile(file, curAgent);
        attachedFiles.value.push({
          hash: data.hash,
          filename: data.storedName || data.originalName || '',
          filesize: data.size,
          text: data.path,
        });
      } catch (err) {
        console.error('[ChatInput] Upload failed:', err);
      }
    }
    uploading.value = false;
  };
  input.click();
}

function removeFile(index: number) {
  attachedFiles.value.splice(index, 1);
}
</script>

<template>
  <div class="chat-input">
    <InteractionBar />
    <div v-if="attachedFiles.length" class="attachments">
      <div v-for="(f, i) in attachedFiles" :key="i" class="attachment-chip">
        <span>{{ f.filename }}</span>
        <button class="remove-btn" @click="removeFile(i)">×</button>
      </div>
    </div>
    <div class="input-row">
      <button class="attach-btn" title="上传附件" @click="triggerFileUpload" :disabled="uploading">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
      </button>
      <textarea
        v-model="inputText"
        class="input-textarea"
        :placeholder="placeholder || '输入消息...'"
        :disabled="disabled"
        rows="1"
        @keydown="onKeydown"
      />
      <button class="send-btn" @click="send" :disabled="disabled || (!inputText.trim() && attachedFiles.length === 0)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  padding: 10px 16px 14px;
  border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
}
.attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.attachment-chip {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; padding: 3px 8px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.06));
  border-radius: 6px; color: var(--color-text-secondary);
}
.remove-btn { border: none; background: none; color: var(--color-text-tertiary); cursor: pointer; font-size: 14px; }
.input-row { display: flex; align-items: flex-end; gap: 8px; }
.attach-btn, .send-btn {
  width: 34px; height: 34px; flex-shrink: 0;
  border: none; border-radius: 8px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.attach-btn { background: transparent; color: var(--color-text-secondary); }
.attach-btn:hover { background: var(--color-bg-hover, rgba(255, 255, 255, 0.06)); }
.send-btn { background: var(--color-primary, #6366f1); color: #fff; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.input-textarea {
  flex: 1;
  min-height: 36px;
  max-height: 160px;
  resize: none;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--color-bg-input, rgba(255, 255, 255, 0.04));
  color: var(--color-text-primary);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
}
.input-textarea:focus { outline: none; border-color: var(--color-primary, #6366f1); }
</style>
