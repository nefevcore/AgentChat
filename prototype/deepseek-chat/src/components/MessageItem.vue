<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ChatMessage } from '../types';

const props = defineProps<{
  message: ChatMessage;
}>();

const showReasoning = ref(false);

const isUser = computed(() => props.message.role === 'user');
const hasReasoning = computed(() => !!props.message.reasoning);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 简单的 Markdown 转 HTML（粗体、代码块、行内代码）
function renderContent(text: string): string {
  if (!text) return '';
  // 转义 HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 代码块 ```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
  // 行内代码 `
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 粗体 **
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 斜体 *
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // 换行
  html = html.replace(/\n/g, '<br>');
  return html;
}
</script>

<template>
  <div class="message" :class="{ user: isUser }">
    <!-- 头像 -->
    <div class="avatar">
      <svg v-if="isUser" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <line x1="9" y1="9" x2="15" y2="9" />
        <line x1="9" y1="13" x2="15" y2="13" />
        <line x1="9" y1="17" x2="12" y2="17" />
      </svg>
    </div>

    <div class="message-body">
      <!-- 角色 + 时间 -->
      <div class="message-header">
        <span class="role">{{ isUser ? '你' : 'DeepSeek' }}</span>
        <span class="time">{{ formatTime(message.timestamp) }}</span>
        <span v-if="message.isStreaming" class="streaming-badge">生成中...</span>
      </div>

      <!-- 深度思考内容 -->
      <div v-if="hasReasoning" class="reasoning-section">
        <button class="reasoning-toggle" @click="showReasoning = !showReasoning">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-right: 3px;">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z" />
            <path d="M12 6v4l3 3" />
          </svg>
          深度思考 {{ showReasoning ? '▾' : '▸' }}
        </button>
        <div v-if="showReasoning" class="reasoning-content">
          {{ message.reasoning }}
        </div>
      </div>

      <!-- 消息内容 -->
      <div
        class="message-content"
        v-html="renderContent(message.content)"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  max-width: 85%;
}

.message.user {
  margin-left: auto;
  flex-direction: row-reverse;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
  background: var(--avatar-bg);
}

.message-body {
  flex: 1;
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.role {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}

.time {
  font-size: 11px;
  color: var(--text-secondary);
}

.streaming-badge {
  font-size: 11px;
  color: var(--accent-color);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.message-content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
  white-space: pre-wrap;
}

.user .message-content {
  background: var(--bubble-user-bg);
  padding: 10px 16px;
  border-radius: 16px 4px 16px 16px;
}

.message:not(.user) .message-content {
  background: var(--bubble-assistant-bg);
  padding: 10px 16px;
  border-radius: 4px 16px 16px 16px;
}

.message-content :deep(pre) {
  background: var(--code-bg);
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.5;
}

.message-content :deep(code) {
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

.message-content :deep(p) {
  margin: 0;
}

.reasoning-section {
  margin-bottom: 8px;
}

.reasoning-toggle {
  background: none;
  border: none;
  color: var(--accent-color);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 0;
  transition: opacity 0.15s;
}

.reasoning-toggle:hover {
  opacity: 0.8;
}

.reasoning-content {
  margin-top: 6px;
  padding: 10px 14px;
  background: var(--reasoning-bg);
  border-left: 3px solid var(--accent-color);
  border-radius: 0 8px 8px 0;
  font-size: 13px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  line-height: 1.6;
}
</style>
