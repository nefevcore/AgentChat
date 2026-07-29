<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const stdout = computed(() => String(props.data.stdout || props.data.output || ''));
const stderr = computed(() => String(props.data.stderr || ''));
const truncated = computed(() => Boolean(props.data.truncated));
const hasOutput = computed(() => !!(stdout.value || stderr.value));
const hasStderr = computed(() => !!stderr.value);
</script>

<template>
  <div class="tool-result-terminal">
    <template v-if="hasOutput">
      <div v-if="stdout" class="term-block">
        <div class="term-banner">
          <span class="term-banner-label">终端输出</span>
          <span v-if="hasStderr" class="term-banner-hint">含 stderr</span>
        </div>
        <pre><code>{{ stdout }}</code></pre>
      </div>
      <div v-if="stderr" class="term-block term-stderr">
        <div class="term-banner term-banner-err">
          <span class="term-banner-label">标准错误</span>
        </div>
        <pre><code>{{ stderr }}</code></pre>
      </div>
      <div v-if="truncated" class="term-truncated">
        ⚠ 输出已截断
      </div>
    </template>
    <div v-else class="term-empty">(无输出)</div>
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
}

/* ---- 内容区 ---- */
.term-block pre {
  margin: 0;
  padding: 16px 20px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--color-text-primary);
  background: var(--color-code-bg);
  max-height: 60vh;
  overflow: auto;
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
</style>
