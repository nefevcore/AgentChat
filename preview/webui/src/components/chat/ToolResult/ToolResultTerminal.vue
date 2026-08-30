<script setup lang="ts">
import { computed } from 'vue';
import ScrollableViewport from '@/components/chat/ScrollableViewport.vue';

const props = defineProps<{ data: Record<string, unknown>; loading?: boolean }>();

// 终端输入（bash 工具返回 command）+ 执行环境
const command = computed(() => String(props.data.command || ''));
const cwd = computed(() => String(props.data.cwd || ''));
const exitCode = computed(() => {
  const c = props.data.exit_code;
  return c === undefined || c === null ? null : Number(c);
});
const stdout = computed(() => String(props.data.stdout || props.data.output || ''));
const stderr = computed(() => String(props.data.stderr || ''));
// 执行失败时的错误信息 + 引导
const errorMessage = computed(() => String(props.data.message || ''));
const guidance = computed(() => String(props.data.guidance || ''));
const truncated = computed(() => Boolean(props.data.truncated));
const timedOut = computed(() => Boolean(props.data.timed_out));
const hasCommand = computed(() => !!command.value);
const hasOutput = computed(() => !!(stdout.value || stderr.value));
const hasStderr = computed(() => !!stderr.value);
const isError = computed(() => exitCode.value !== null && exitCode.value !== 0);
</script>

<template>
  <div class="tool-result-terminal">
    <!-- 终端命令（输入） -->
    <div v-if="hasCommand" class="term-block term-cmd">
      <div class="term-banner">
        <span class="term-banner-label">终端命令</span>
        <span v-if="cwd" class="term-banner-hint" :title="cwd">{{ cwd }}</span>
      </div>
      <!-- 命令区固定高度可滚动（参考代码面板：banner 固定 + 内容滚动，超长命令不撑爆消息） -->
      <ScrollableViewport max-height="260px">
        <div class="term-cmd-body">
          <span class="term-prompt">$</span>
          <code class="term-cmd-text">{{ command }}</code>
        </div>
      </ScrollableViewport>
    </div>

    <!-- 执行中：命令已显示，输出尚未返回 -->
    <div v-if="loading && !hasOutput" class="term-loading">
      <span class="loading-dot dot-yellow"></span>
      <span class="loading-dot dot-gray"></span>
      <span class="loading-dot dot-gray"></span>
      <span class="term-loading-text">正在执行...</span>
    </div>

    <!-- 执行失败信息：无输出时红色展示；有输出时作为黄色引导展示，避免吞掉修复提示 -->
    <div v-if="errorMessage && !hasOutput" class="term-error">
      {{ errorMessage }}
    </div>
    <div v-if="errorMessage && hasOutput" class="term-guidance">
      {{ errorMessage }}
    </div>
    <div v-if="guidance" class="term-guidance">
      {{ guidance }}
    </div>

    <!-- 输出 -->
    <template v-if="hasOutput">
      <div v-if="stdout" class="term-block">
        <div class="term-banner">
          <span class="term-banner-label">终端输出</span>
          <span v-if="hasStderr" class="term-banner-hint">含 stderr</span>
          <span v-else-if="isError" class="term-banner-exit">exit {{ exitCode }}</span>
        </div>
        <ScrollableViewport max-height="40vh"><pre><code>{{ stdout }}</code></pre></ScrollableViewport>
      </div>
      <div v-if="stderr" class="term-block term-stderr">
        <div class="term-banner term-banner-err">
          <span class="term-banner-label">标准错误</span>
        </div>
        <ScrollableViewport max-height="30vh"><pre><code>{{ stderr }}</code></pre></ScrollableViewport>
      </div>
      <div v-if="truncated || timedOut" class="term-truncated">
        ⚠ {{ truncated ? '输出已截断' : '' }}{{ truncated && timedOut ? '；' : '' }}{{ timedOut ? '命令超时' : '' }}
      </div>
    </template>
    <div v-else-if="!hasCommand && !errorMessage" class="term-empty">(无输出)</div>
  </div>
</template>

<style scoped>
.tool-result-terminal {
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.term-block {
  border-radius: 10px;
  overflow: hidden;
  background: var(--color-code-bg);
  border: 1px solid var(--color-code-border, #dfe6e9);
}

/* ---- 顶部栏 ---- */
.term-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 36px;
  background: var(--color-code-toolbar, #eceff1);
  border-radius: 10px 10px 0 0;
  user-select: none;
}
.term-banner-err {
  background: rgba(231, 76, 60, 0.08);
}

.term-banner-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.term-banner-hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-banner-exit {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-error, #e74c3c);
}

/* ---- 终端命令块 ---- */
.term-cmd-body {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #0f1117;
  border-radius: 0 0 10px 10px;
}

.term-prompt {
  color: #4ade80;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  font-weight: 700;
  user-select: none;
  flex-shrink: 0;
}

.term-cmd-text {
  font-family: Consolas, 'Courier New', monospace !important;
  font-size: 12px;
  line-height: 1.5;
  color: #e2e8f0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ---- 错误信息 ---- */
.term-error {
  font-size: 12px;
  color: var(--color-error, #e74c3c);
  padding: 8px 4px;
}

.term-guidance {
  font-size: 12px;
  color: var(--color-warning, #f59e0b);
  padding: 2px 4px 8px;
}

/* ---- 内容区 ---- */
.term-block pre {
  margin: 0;
  padding: 16px 20px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--color-text-primary);
  background: var(--color-code-bg);


  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, 'Courier New', monospace !important;
  border-radius: 0 0 10px 10px;
}
.term-block pre code {
  font-family: inherit;
  color: inherit;
}

.term-stderr pre {
  color: var(--color-error, #e74c3c);
}

.term-truncated {
  font-size: 11px;
  color: #f59e0b;
}

.term-empty {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

/* ---- 执行中 loading ---- */
.term-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-code-bg, rgba(0, 0, 0, 0.35));
  border-radius: 8px;
}
.term-loading .loading-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  animation: term-dot-pulse 1.4s infinite ease-in-out;
}
.term-loading .loading-dot.dot-yellow { background: #e6a817; }
.term-loading .loading-dot.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.term-loading .loading-dot.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes term-dot-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.term-loading-text { margin-left: 2px; }
</style>
