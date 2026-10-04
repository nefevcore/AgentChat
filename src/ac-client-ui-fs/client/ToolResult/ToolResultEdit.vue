<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import ScrollableViewport from 'ac-client-ui-renderer/client/ScrollableViewport.vue';
import { BusyRing, Tooltip } from '@agentchat/webui-kit';

const props = defineProps<{
  data: Record<string, unknown>;
  toolName?: string;
  loading?: boolean;
}>();

const diffExpanded = ref(true);
const copyState = ref<'idle' | 'copied'>('idle');

// 文件路径：结果里的 path/file，或调用参数里的 file_path/filePath/path
const fileName = computed(() => {
  const p = String(
    props.data.path
    || props.data.file
    || props.data.file_path
    || props.data.filePath
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

let copyTimer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => { if (copyTimer) clearTimeout(copyTimer); });

async function copyDiff() {
  try {
    await navigator.clipboard.writeText(diffText.value);
    copyState.value = 'copied';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 2000);
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
        <span class="ui-badge dim edit-stat">{{ summary }}</span>
        <span v-if="data.first_changed_line" class="ui-badge dim edit-stat">L{{ data.first_changed_line }}</span>
        <Tooltip :text="copyState === 'copied' ? '已复制' : '复制 diff'" placement="top">
          <button class="edit-copy-btn" :class="{ copied: copyState === 'copied' }" :aria-label="copyState === 'copied' ? '已复制' : '复制 diff'" @click="copyDiff">
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
        </Tooltip>
      </div>
    </div>

    <!-- Diff 内容 -->
    <ScrollableViewport class="edit-diff-viewport">
      <div class="edit-diff-body">
        <!-- 执行中（调用阶段即可看到文件卡） -->
        <div v-if="loading && !diffText" class="edit-loading">
          <BusyRing :size="13" />
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
  border-radius: var(--r-md);
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--bg-base);
}

/* ── 头部 ── */
.edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--line);
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

/* 工具身份色（edit = 紫；非语义状态色，cr-129 保留理由：工具身份分类色，与 jobs 包 kind 身份色同族） */
.edit-icon {
  color: #8b5cf6;
  flex-shrink: 0;
}

.edit-file-name {
  font-size: 12px;
  font-weight: 600;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* cr-129 R3：元信息徽章 = ui-badge dim（形状/配色归 kit 徽章族） */
.edit-stat {
  white-space: nowrap;
}

.edit-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-2);
  background: var(--bg-base);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.edit-copy-btn:hover {
  color: var(--text-1);
  border-color: var(--line);
  background: var(--bg-surface);
}

.edit-copy-btn.copied {
  color: var(--ok);
  border-color: var(--ok);
  background: rgba(var(--ok-rgb), 0.08);
}

/* ── Diff 视口 ── */
.edit-diff-viewport {
  position: relative;
  background: var(--code-bg);
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

/* ── diff 行颜色（cr-147 对齐 FileEditsPanel 方案 B）：语义由行底 tint 承载，
   正文用 code-text——大段红绿文字是色噪 */
.diff-del {
  background: rgba(var(--err-rgb), 0.12);
}
.diff-del .diff-content {
  color: var(--code-text);
}

.diff-add {
  background: rgba(var(--ok-rgb), 0.1);
}
.diff-add .diff-content {
  color: var(--code-text);
}

.diff-ctx .diff-content {
  color: var(--text-3);
  opacity: 0.7;
}

.diff-sep .diff-content {
  color: var(--text-3);
  opacity: 0.5;
  font-style: italic;
}

.edit-no-diff {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-3);
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}

.edit-plain-text {
  margin: 0;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.7;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  color: var(--text-2);
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
  color: var(--text-2);
}
/* cr-129 R2：自建忙指示（三点脉冲）→ BusyRing（忙指示唯一源） */
.edit-loading-text { margin-left: 2px; }

</style>
