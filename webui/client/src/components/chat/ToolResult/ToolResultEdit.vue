<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  data: Record<string, unknown>;
  toolName?: string;
}>();

const DIFF_COLLAPSE_THRESHOLD = 150;
const diffExpanded = ref(false);
const copyState = ref<'idle' | 'copied'>('idle');

const fileName = computed(() => {
  const p = String(props.data.path || props.data.file || '');
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

const isLongDiff = computed(() => diffLines.value.length > DIFF_COLLAPSE_THRESHOLD);

const displayLines = computed(() => {
  if (isLongDiff.value && !diffExpanded.value) {
    return diffLines.value.slice(0, DIFF_COLLAPSE_THRESHOLD);
  }
  return diffLines.value;
});

const hiddenLines = computed(() => {
  if (!isLongDiff.value || diffExpanded.value) return 0;
  return diffLines.value.length - DIFF_COLLAPSE_THRESHOLD;
});

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

watch(diffText, () => { diffExpanded.value = false; });
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
    <div class="edit-diff-viewport">
      <div class="edit-diff-body">
        <!-- 有 diff 标记时按行渲染 -->
        <template v-if="hasDiffMarkers">
          <div
            v-for="(line, i) in displayLines"
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

      <!-- 折叠提示 -->
      <div v-if="isLongDiff && !diffExpanded" class="edit-fold-bar">
        <div class="edit-fold-gradient"></div>
        <button class="edit-fold-btn" @click.stop="diffExpanded = true">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          展开全部 {{ hiddenLines }} 行
        </button>
      </div>
      <button v-if="isLongDiff && diffExpanded" class="edit-fold-btn edit-fold-collapse" @click.stop="diffExpanded = false">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="18 15 12 9 6 15"/>
        </svg>
        收起
      </button>
    </div>
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
  font-size: 13px;
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
  font-size: 13px;
  line-height: 1.65;
  min-height: calc(13px * 1.65);
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
  font-size: 13px;
  color: var(--color-text-tertiary);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}

.edit-plain-text {
  margin: 0;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.7;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 折叠栏 ── */
.edit-fold-bar {
  position: relative;
}

.edit-fold-gradient {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(to bottom, transparent, var(--color-code-bg));
  pointer-events: none;
}

.edit-fold-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 500;
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.04);
  border: none;
  border-top: 1px solid rgba(48, 54, 61, 0.6);
  cursor: pointer;
  transition: background 0.15s;
}

.edit-fold-btn:hover {
  background: rgba(88, 166, 255, 0.1);
}

.edit-fold-collapse {
  color: var(--color-text-tertiary);
  background: rgba(128, 128, 128, 0.04);
}

.edit-fold-collapse:hover {
  background: rgba(128, 128, 128, 0.1);
}
</style>
