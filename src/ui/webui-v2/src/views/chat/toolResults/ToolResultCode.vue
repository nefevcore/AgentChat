<!-- ToolResultCode.vue —— read 工具结果（代码预览） -->
<script setup lang="ts">
import { computed } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';

const props = defineProps<{ data: any; raw?: string }>();

const { render } = useMarkdown();
const content = computed(() => {
  const path = props.data?.path || props.data?.file || '';
  const text = props.data?.text ?? props.data?.content ?? props.raw ?? '';
  return `**${path}**\n\n\`\`\`\n${text}\n\`\`\``;
});
</script>

<template>
  <div class="tool-code">
    <div v-html="render(content)" class="code-render" />
  </div>
</template>

<style scoped>
.tool-code { max-width: 100%; }
.code-render :deep(pre) {
  background: var(--color-bg-code, rgba(0, 0, 0, 0.35));
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
  font-size: 12.5px;
  font-family: 'Cascadia Code', Consolas, monospace;
  max-height: 320px;
  overflow-y: auto;
}
.code-render :deep(code) { font-family: inherit; }
</style>
