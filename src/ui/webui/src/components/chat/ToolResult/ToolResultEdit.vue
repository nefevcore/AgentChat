<script setup lang="ts">
import { computed, ref } from 'vue';
import ScrollableViewport from '@/components/chat/ScrollableViewport.vue';

const props = defineProps<{
  data: Record<string, unknown>;
  toolName?: string;
  loading?: boolean;
}>();

const diffExpanded = ref(true);
const copyState = ref<'idle' | 'copied'>('idle');

// 文件路径：结果里的 path/file，或调用参数里的 filePath/path/input（Hashline 头 [path#tag]）
const fileName = computed(() => {
  const p = String(
    props.data.path
    || props.data.file
    || props.data.filePath
    || ((props.data.input as string) || '').match(/^\[([^#\]]+)/)?.[1]
    || ''
  );
  return p.split(/[/\\]/).pop() || p || '(未知)';
});

const editsApplied = computed(() => Number(props.data.edits_applied) || 0);
const fuzzyMatches = computed(() => Number(props.data.fuzzy_matches) || 0);

const summary = computed(() => {
  let s = `${editsApplied.value} 处替换`;
  if (fuzzyMatches.value > 0) s += `（含 ${fuzzyMatches.value} 处模糊匹配）`;
  return s;
});

const diffText = computed(() => String(props.data.diff || ''));

const diffLines = computed(() => {
  const text = diffText.value;
  return text ? text.split('\n') : [];
});

const hasDiffMarkers = computed(() =>
  diffLines.value.some(l => l.startsWith('- ') || l.startsWith('+ '))
);




function lineClass(line: string) {
  if (line.startsWith('- ')) return 'diff-del';
  if (line.startsWith('+ ')) return 'diff-add';
  if (line === '...') return 'diff-sep';
  if (line.startsWith('  ')) return 'diff-ctx';
  return '';
}

async function copyDiff() {
  try {
    await navigator.clipboard.writeText(diffText.value);
    copyState.value = 'copied';
    setTimeout(() => { copyState.value = 'idle'; }, 2000);
  } catch { /* ignore */ }
}

</script>

<template>
  <div class="tool-result-edit">
    <!-- 头部信息栏 -->
    <div class="edit-header">
      <div class="edit-header-left">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="edit-icon">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        <span class="edit-file-name">{{ fileName }}</span>
      </div>
      <div class="edit-header-right">
        <span class="edit-stat">{{ summary }}</span>
        <span v-if="data.first_changed_line" class="edit-stat">L{{ data.first_changed_line }}</span>
        <button class="edit-copy-btn" :class="{ copied: copyState === 'copied' }" @click="copyDiff" title="复制 diff">
          <svg v-if="copyState !== 'copied'" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>{{ copyState === 'copied' ? '已复制' : '复制' }}</span>
        </button>
      </div>
    </div>

    <!-- Diff 内容 -->
    <ScrollableViewport class="edit-diff-viewport">
      <div class="edit-diff-body">
        <!-- 执行中（调用阶段即可看到文件卡） -->
        <div v-if="loading && !diffText" class="edit-loading">
          <span class="loading-dot dot-yellow"></span>
          <span class="loading-dot dot-gray"></span>
          <span class="loading-dot dot-gray"></span>
          <span class="edit-loading-text">正在应用编辑...</span>
        </div>
        <!-- 有 diff 标记时按行渲染 -->
        <template v-else-if="hasDiffMarkers">
          <div
            v-for="(line, i) in diffLines"
            :key="i"
            class="diff-line"
            :class="lineClass(line)"
          >
            <span class="diff-content">{{ line }}</span>
          </div>
        </template>
        <!-- 无标记时以纯文本展示 -->
        <pre v-else-if="diffText" class="edit-plain-text">{{ diffText }}</pre>
        <div v-else class="edit-no-diff">（无变更）</div>
      </div>
    </ScrollableViewport>
  </div>
</template>

<style scoped>
.tool-result-edit {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--color-border-light, #e5e7eb);
  background: var(--color-bg-page);
}

/* ── 头部 ── */
.edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border-light, #e5e7eb);
  gap: 8px;
  flex-wrap: wrap;
}

.edit-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.edit-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.edit-icon {
  color: #8b5cf6;
  flex-shrink: 0;
}

.edit-file-name {
  font-size: 12px;
  font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.edit-stat {
  font-size: 11px;
  color: var(--color-text-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-light, #e5e7eb);
  white-space: nowrap;
}

.edit-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-light, #e5e7eb);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.edit-copy-btn:hover {
  color: var(--color-text-primary);
  border-color: var(--color-border-secondary);
  background: var(--color-bg-surface);
}

.edit-copy-btn.copied {
  color: #22c55e;
  border-color: #22c55e;
  background: rgba(34, 197, 94, 0.08);
}

/* ── Diff 视口 ── */
.edit-diff-viewport {
  position: relative;
  background: var(--color-code-bg);
}

.edit-diff-body {
  overflow-x: auto;
}

.diff-line {
  display: flex;
  padding: 1px 16px;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.65;
  min-height: calc(12px * 1.65);
}

.diff-content {
  white-space: pre;
  flex: 1;
}

/* ── diff 行颜色 ── */
.diff-del {
  background: rgba(239, 68, 68, 0.12);
}
.diff-del .diff-content {
  color: #f87171;
}

.diff-add {
  background: rgba(34, 197, 94, 0.1);
}
.diff-add .diff-content {
  color: #4ade80;
}

.diff-ctx .diff-content {
  color: var(--color-text-tertiary);
  opacity: 0.7;
}

.diff-sep .diff-content {
  color: var(--color-text-tertiary);
  opacity: 0.5;
  font-style: italic;
}

.edit-no-diff {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--color-text-tertiary);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}

.edit-plain-text {
  margin: 0;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.7;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- 执行中 loading ---- */
.edit-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.edit-loading .loading-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  animation: edit-dot-pulse 1.4s infinite ease-in-out;
}
.edit-loading .loading-dot.dot-yellow { background: #e6a817; }
.edit-loading .loading-dot.dot-gray { background: #a8abb2; animation-delay: 0.3s; }
.edit-loading .loading-dot.dot-gray:last-child { animation-delay: 0.6s; }
@keyframes edit-dot-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
.edit-loading-text { margin-left: 2px; }

</style>
