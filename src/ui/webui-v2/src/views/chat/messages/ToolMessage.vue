<!-- ToolMessage.vue —— 工具调用/结果消息
     通过工具结果渲染插槽分发具体展示组件（按工具名），
     未知工具回退到 fallback（可被注册覆盖）。 -->
<script setup lang="ts">
import { ref, computed, toRef, nextTick } from 'vue';
import type { ChatMessage } from '@/domain/types';
import { parseToolResult } from '@/domain/toolResult';
import { getToolResultView } from '@/framework/toolResultViews';

const props = defineProps<{
  message: ChatMessage;
  index: number;
}>();

const isExpanded = ref(false);
const resultComponentRef = ref<{ open?: () => void }>();

const parsed = computed(() => parseToolResult(props.message.content));
const isJson = computed(() => parsed.value !== null);

const ResultComponent = computed(() => {
  const toolName = props.message.toolName || props.message.name;
  return getToolResultView(toolName) || null;
});

const isWriteTool = computed(() => {
  const name = props.message.toolName || props.message.name;
  return name === 'write' && parsed.value?.data?.path;
});

const displayName = computed(() => {
  if (props.message.label) return props.message.label;
  if (props.message.name) return props.message.name;
  if (props.message.toolCalls?.length) {
    return props.message.toolCalls.map(tc => tc.function.name).join(', ');
  }
  return '工具调用';
});

const statusIcon = computed(() => {
  if (props.message.isStreaming) return 'running';
  if (props.message.status === 'error' || props.message.isError) return 'error';
  if (parsed.value?.status === 'error') return 'error';
  if (parsed.value?.status === 'blocked') return 'blocked';
  return 'success';
});

const resultData = computed(() => parsed.value?.data || parsed.value || {});

function handleLabelClick() {
  if (isWriteTool.value) {
    isExpanded.value = true;
    nextTick(() => resultComponentRef.value?.open?.());
  } else {
    toggleExpand();
  }
}
function toggleExpand() { isExpanded.value = !isExpanded.value; }
</script>

<template>
  <div class="message-item message-tool">
    <div class="tool-section">
      <!-- 标签栏 -->
      <div class="tool-label" @click="handleLabelClick()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tool-label-icon">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span class="tool-label-name">{{ displayName }}</span>

        <span v-if="statusIcon === 'running'" class="streaming-dots">
          <span class="dot dot-yellow"></span>
          <span class="dot dot-gray"></span>
          <span class="dot dot-gray"></span>
        </span>
        <span v-else-if="statusIcon === 'success'" class="tool-status-done">OK</span>
        <span v-else-if="statusIcon === 'error'" class="tool-status-error">ERR</span>
        <span v-else-if="statusIcon === 'blocked'" class="tool-status-blocked">BLK</span>

        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          class="collapse-chevron" :class="{ 'chevron-expanded': isExpanded }">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>

      <!-- 内容体 -->
      <div v-show="isExpanded" class="tool-body">
        <template v-if="isJson && parsed">
          <div v-if="parsed.status === 'error'" class="tool-json-error">
            {{ parsed.message || (parsed.data as any)?.message || '(命令执行失败，见下方输出)' }}
          </div>
          <div v-else-if="parsed.status === 'warning'" class="tool-json-warning">
            {{ parsed.message || (parsed.data as any)?.message }}
          </div>
          <div v-else-if="parsed.status === 'blocked'" class="tool-json-blocked">
            ⛔ {{ parsed.message || (parsed.data as any)?.message }}
          </div>
          <!-- 注册的工具结果视图（按工具名分发） -->
          <component
            v-if="ResultComponent"
            :is="ResultComponent"
            :data="resultData"
            :raw="message.content"
            ref="resultComponentRef"
          />
          <div v-else class="tool-json-default">
            <pre>{{ message.content }}</pre>
          </div>
        </template>
        <template v-else>
          <pre class="tool-plain">{{ message.content }}</pre>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-tool { width: 100%; }
.tool-section { display: flex; flex-direction: column; }
.tool-label {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
  cursor: pointer; user-select: none;
  width: fit-content;
  border: 1px solid transparent;
  transition: border-color 0.15s;
}
.tool-label:hover { border-color: var(--color-border, rgba(255, 255, 255, 0.15)); }
.tool-label-icon { color: var(--color-text-tertiary, #a8abb2); flex-shrink: 0; }
.tool-label-name { font-size: 13px; font-weight: 500; color: var(--color-text-secondary); }
.streaming-dots { display: inline-flex; gap: 2px; }
.dot { width: 4px; height: 4px; border-radius: 50%; animation: dot-pulse 1.4s infinite ease-in-out; }
.dot-yellow { background: #e6a817; }
.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes dot-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.tool-status-done { font-size: 11px; font-weight: 600; color: #2ecc71; }
.tool-status-error { font-size: 11px; font-weight: 600; color: #e74c3c; }
.tool-status-blocked { font-size: 11px; font-weight: 600; color: #e67e22; }
.collapse-chevron { transition: transform 0.2s; color: var(--color-text-tertiary, #a8abb2); }
.chevron-expanded { transform: rotate(90deg); }
.tool-body { margin-top: 6px; padding-left: 2px; max-width: 100%; }
.tool-json-error, .tool-json-warning, .tool-json-blocked {
  font-size: 13px; padding: 8px 12px; border-radius: 8px; margin-bottom: 6px;
}
.tool-json-error { background: rgba(231, 76, 60, 0.1); color: #e74c3c; }
.tool-json-warning { background: rgba(241, 196, 15, 0.1); color: #f1c40f; }
.tool-json-blocked { background: rgba(230, 126, 34, 0.1); color: #e67e22; }
.tool-json-default pre, .tool-plain {
  font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
  color: var(--color-text-secondary);
  background: var(--color-bg-code, rgba(0, 0, 0, 0.35));
  padding: 10px; border-radius: 8px; overflow-x: auto;
  font-family: 'Cascadia Code', Consolas, monospace;
}
</style>
