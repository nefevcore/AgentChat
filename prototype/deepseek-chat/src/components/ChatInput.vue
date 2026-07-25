<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  disabled?: boolean;
  isStreaming?: boolean;
}>();

const emit = defineEmits<{
  send: [text: string, deepThink: boolean];
  stop: [];
}>();

const inputText = ref('');
const deepThink = ref(true);

function send() {
  const text = inputText.value.trim();
  if (!text || props.disabled) return;
  emit('send', text, deepThink.value);
  inputText.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="chat-input">
    <textarea
      v-model="inputText"
      class="input-field"
      :disabled="disabled"
      placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
      @keydown="onKeydown"
      rows="3"
    />

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
      </div>

      <div class="toolbar-right">
        <button
          v-if="!isStreaming"
          class="send-btn"
          :disabled="!inputText.trim() || disabled"
          @click="send"
        >
          发送
        </button>
        <button
          v-else
          class="send-btn interrupting"
          @click="emit('stop')"
        >
          打断
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
  background: var(--color-bg-primary, var(--chat-bg));
  border: 1px solid var(--border-color);
  border-radius: 14px;
  flex-shrink: 0;
  margin: 0 10px 10px;
}

.input-field {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  resize: none;
  min-height: 60px;
  font-family: inherit;
  padding: 4px 2px;
}

.input-field::placeholder {
  color: var(--text-secondary);
}

.input-field:disabled {
  opacity: 0.6;
}

.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.toolbar-btn:hover {
  background: var(--hover-bg);
  color: var(--text-primary);
}

.toolbar-btn.active {
  color: var(--accent-color);
  border-color: var(--accent-color);
  background: var(--active-bg);
}

.toolbar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.toolbar-right {
  display: flex;
  align-items: center;
}

.send-btn {
  padding: 6px 18px;
  background: var(--accent-color);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s;
  white-space: nowrap;
}

.send-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send-btn.interrupting {
  background: #e74c3c;
  animation: pulse-btn 1.5s ease-in-out infinite;
}

@keyframes pulse-btn {
  0%, 100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(231, 76, 60, 0); }
}
</style>
