<!-- ToolResultEdit.vue —— edit 工具结果 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';

const props = defineProps<{ data: any; raw?: string }>();

const { render } = useMarkdown();
const path = computed(() => props.data?.path || props.data?.file || '');
const diff = computed(() => props.data?.diff ?? props.data?.output ?? props.raw ?? '');
</script>

<template>
  <div class="tool-edit">
    <div class="edit-header">
      <span class="edit-label">🔧 已编辑</span>
      <span class="edit-path">{{ path }}</span>
    </div>
    <div v-if="diff" v-html="render('```diff\n' + diff + '\n```')" class="edit-diff" />
  </div>
</template>

<style scoped>
.tool-edit {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  overflow: hidden;
}
.edit-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.04));
}
.edit-label { font-size: 12px; font-weight: 600; color: #3498db; }
.edit-path { font-size: 12.5px; color: var(--color-text-secondary); font-family: 'Cascadia Code', Consolas, monospace; }
.edit-diff { padding: 8px 12px; }
.edit-diff :deep(pre) {
  background: var(--color-bg-code, rgba(0, 0, 0, 0.35));
  border-radius: 6px;
  padding: 8px;
  overflow-x: auto;
  font-size: 12px;
  max-height: 240px;
  overflow-y: auto;
}
</style>
