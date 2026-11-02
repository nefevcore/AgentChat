<!-- ============================================================
  webui-kit/src/base/RawCard.vue —— 纯文本兜底卡（cr-765 批次A §1.3）
  不可解析结果 / 未知工具 / 纯文本的统一渲染体：mono 正文 + 限高滚动。
  排版沿 ToolMessage 旧 .tool-output 取值（12px/1.7 mono，pre-wrap）。
  ============================================================ -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { formatFileSize } from '../format.ts';

const props = withDefaults(defineProps<{
  /** 纯文本正文（原样渲染） */
  text?: string;
  /** mono 字体（默认开；纯散文文本可关） */
  mono?: boolean;
  /** 限高（缺省取会话卡统一限高令牌；传 none 可解除） */
  maxHeight?: string;
}>(), { text: '', mono: true, maxHeight: 'var(--card-viewport-max)' });

const el = ref<HTMLElement | null>(null);
const atBottom = ref(true);

function onScroll() {
  const node = el.value;
  if (!node) return;
  atBottom.value = node.scrollHeight - node.scrollTop - node.clientHeight < 16;
}

// 流式增量（text 变化）：底部附近吸底跟随（轻量版——整块到达非逐 token）
watch(() => props.text, () => {
  requestAnimationFrame(() => {
    const node = el.value;
    if (!node || !atBottom.value) return;
    node.scrollTop = node.scrollHeight;
  });
});
</script>

<template>
  <pre ref="el" class="raw-card" :class="{ mono }" :style="maxHeight ? { maxHeight } : {}" @scroll="onScroll"><code>{{ text }}</code></pre>
</template>

<style scoped>
.raw-card {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  color: var(--text-2);
  background: transparent;
  max-height: var(--card-viewport-max);
  overflow-y: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.raw-card:not(.mono) { font-family: var(--font-ui); }
.raw-card::-webkit-scrollbar { width: 5px; }
.raw-card::-webkit-scrollbar-track { background: transparent; }
.raw-card::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
.raw-card::-webkit-scrollbar-thumb:hover { background: var(--line-strong); }
</style>