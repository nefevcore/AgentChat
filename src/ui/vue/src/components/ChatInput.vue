<script setup lang="ts">
import { ref } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import type { FileAttachment } from '../types';
import InteractionBar from './InteractionBar.vue';

const props = defineProps<{
  /** 禁用输入 */
  disabled?: boolean;
  /** 占位文本 */
  placeholder?: string;
  /** 自定义发送回调（提供则替代 store.sendMessage） */
  onSend?: (text: string) => void;
}>();

const store = useChatStore();
const inputText = ref('');
const deepThink = ref(true);
const attachedFiles = ref<FileAttachment[]>([]);
const uploading = ref(false);

// ---- 发送消息 ----
function send() {
  const text = inputText.value.trim();
  if (!text && attachedFiles.value.length === 0) return;

  if (props.onSend) {
    props.onSend(text);
  } else {
    // Agent 正在运行时先打断（chat.interrupt → 中止 LLM/工具），再发新消息
    if (store.turnInProgress) {
      store.interruptGeneration();
    }
    store.sendMessage(text, undefined, {
      deepThink: deepThink.value,
      files: attachedFiles.value,
    });
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

// ---- 附件上传 ----
function triggerFileUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    const files = input.files;
    if (!files || files.length === 0) return;

    uploading.value = true;
    for (const file of Array.from(files)) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        // 带当前对话 Agent → files/<agentId>/_tmp/；未选中 Agent → files/_tmp/（全局）
        const curAgent = useAgentStore().activeAgentId;
        if (curAgent && curAgent !== 'user') {
          formData.append('agentId', curAgent);
        }

        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (res.ok) {
          const data = await res.json();
          attachedFiles.value.push({
            hash: data.hash,
            filename: data.storedName || data.originalName,
            filesize: data.size,
            text: data.path,
          });
        }
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
    <!-- 附件预览 -->
    <div v-if="attachedFiles.length > 0" class="file-preview-bar">
      <div
        v-for="(file, i) in attachedFiles"
        :key="file.hash"
        class="file-chip"
      >
        <span class="file-chip-name">{{ file.filename }}</span>
        <button class="file-chip-remove" @click="removeFile(i)" title="移除">×</button>
      </div>
    </div>

    <!-- ask_user 决策选项条（输入框上方） -->
    <InteractionBar />

    <!-- 输入区 -->
    <textarea
      v-model="inputText"
      :placeholder="store.archivePending ? '当前 Agent 正在归档整理记忆，稍后处理您的回复…' : (placeholder || '输入消息… (Enter 发送, Shift+Enter 换行)')"
      :disabled="disabled"
      @keydown="onKeydown"
      rows="3"
    />

    <!-- 底部工具栏 -->
    <div class="input-toolbar">
      <div class="toolbar-left">
        <button
          class="toolbar-btn"
          :class="{ active: deepThink }"
          @click="deepThink = !deepThink"
          title="深度思考"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z" />
            <path d="M12 6v4l3 3" />
          </svg>
          <span>深度思考</span>
        </button>

        <button
          class="toolbar-btn"
          :disabled="uploading"
          @click="triggerFileUpload"
          title="附件上传"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          <span>附件上传</span>
          <span v-if="uploading" class="uploading-spinner"></span>
        </button>
      </div>

      <div class="toolbar-right">
        <button
          class="send-btn"
          :class="{ interrupting: !onSend && store.turnInProgress }"
          :disabled="disabled || (!inputText.trim() && attachedFiles.length === 0)"
          @click="send"
        >
          {{ (!onSend && store.turnInProgress) ? '打断并发送' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-secondary);
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  margin: 0 10px 10px;
}

/* ---- 附件预览栏 ---- */
.file-preview-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding-bottom: 0;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--color-primary-light);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-primary);
}

.file-chip-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-chip-remove {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  opacity: 0.7;
}

.file-chip-remove:hover {
  opacity: 1;
}

/* ---- 输入框 ---- */
textarea {
  width: 100%;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.5;
  min-height: 56px;
  box-sizing: border-box;
}

textarea::placeholder {
  color: var(--color-text-muted);
}

textarea:focus {
  outline: none;
}

/* ---- 工具栏 ---- */
.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-right {
  display: flex;
  align-items: center;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  white-space: nowrap;
}

.toolbar-btn:hover {
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
}

.toolbar-btn.active {
  background: var(--color-primary-light);
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.uploading-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-border-secondary);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---- 发送按钮 ---- */
.send-btn {
  padding: 5px 14px;
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast);
  white-space: nowrap;
}

.send-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
  transform: scale(1.03);
}

.send-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send-btn.interrupting {
  background: var(--color-warning, #e67e22);
  animation: pulse-interrupt 1.5s ease-in-out infinite;
}

.send-btn.interrupting:hover:not(:disabled) {
  background: #d35400;
}

@keyframes pulse-interrupt {
  0%, 100% { box-shadow: 0 0 0 0 rgba(230, 126, 34, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(230, 126, 34, 0); }
}
</style>

