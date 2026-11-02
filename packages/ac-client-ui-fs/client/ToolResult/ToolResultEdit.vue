<script setup lang="ts">
import { computed } from 'vue';
import CodeCard from 'ac-client-ui-renderer/client/CodeCard.vue';
import { BusyRing } from '@agentchat/webui-kit';

const props = defineProps<{
  data: Record<string, unknown>;
  toolName?: string;
  loading?: boolean;
}>();

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
  return text ? text.split('\\n') : [];
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

</script>

<template>
  <!-- 反馈 #8：edit 卡换 CodeCard 统一壳——头（文件名 + 徽章 controls 插槽 + 复制钮
       归骨架）+ diff 体（默认插槽：自绘行染色精度优先，- / + / ... 前缀语义） -->
  <CodeCard class="tool-result-edit" :code="diffText" lang="diff" :title="fileName">
    <template #controls>
      <span class="ui-badge dim">{{ summary }}</span>
      <span v-if="data.first_changed_line" class="ui-badge dim">L{{ data.first_changed_line }}</span>
    </template>
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
  </CodeCard>
</template>

<style scoped>
/* 反馈 #8：卡壳（边框/圆角/底色/头部）归 CodeCard——本组件只留 diff 体样式 */
.tool-result-edit { min-width: 0; }

/* ── Diff 体（默认插槽内容——自绘行染色，精度优先于 hljs diff）── */
.edit-diff-body {
  overflow-x: auto;
  overflow-y: auto;
  min-width: 0;
  background: var(--code-bg);
  max-height: var(--card-viewport-max);
  /* 滚动条 = 卡内滚动区标准配方（同 CodeCard .cc-scroll：thin + 8px + scroll-thumb 令牌）——
     显式声明，不依赖宿主全局滚动条规则到达本上下文 */
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
}
.edit-diff-body::-webkit-scrollbar { width: 8px; height: 8px; }
.edit-diff-body::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: var(--r-full); }
.edit-diff-body::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }

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
