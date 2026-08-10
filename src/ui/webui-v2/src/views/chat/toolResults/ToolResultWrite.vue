<!-- ToolResultWrite.vue —— write 工具结果（文件写入卡） -->
<script setup lang="ts">
import { computed } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';

const props = defineProps<{ data: any; raw?: string }>();

const { render } = useMarkdown();
const path = computed(() => props.data?.path || props.data?.file || '');
const content = computed(() => props.data?.text ?? props.data?.content ?? props.raw ?? '');

function open() {
  // 预留：打开文件预览
}

defineExpose({ open });
</script>

<template>
  <div class="tool-write">
    <div class="write-header">
      <span class="write-label">✍️ 已写入</span>
      <span class="write-path">{{ path }}</span>
    </div>
    <details class="write-details">
      <summary>查看内容</summary>
      <div v-html="render('```\n' + content + '\n```')" class="write-content" />
    </details>
  </div>
</template>

<style scoped>
.tool-write {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  overflow: hidden;
}
.write-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.04));
}
.write-label { font-size: 12px; font-weight: 600; color: #2ecc71; }
.write-path { font-size: 12.5px; color: var(--color-text-secondary); font-family: 'Cascadia Code', Consolas, monospace; }
.write-details { padding: 8px 12px; }
.write-details summary {
  font-size: 12px;
  color: var(--color-text-tertiary, #a8abb2);
  cursor: pointer;
  user-select: none;
}
.write-content { margin-top: 8px; }
.write-content :deep(pre) {
  background: var(--color-bg-code, rgba(0, 0, 0, 0.35));
  border-radius: 6px;
  padding: 8px;
  overflow-x: auto;
  font-size: 12px;
  max-height: 240px;
  overflow-y: auto;
}
</style>
