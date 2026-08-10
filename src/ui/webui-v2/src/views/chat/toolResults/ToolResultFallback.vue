<!-- ToolResultFallback.vue —— 未知工具兜底 -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: any; raw?: string }>();

const text = computed(() => {
  const d = props.data;
  if (d && typeof d === 'object' && Object.keys(d).length) {
    return JSON.stringify(d, null, 2);
  }
  return props.raw ?? '';
});
</script>

<template>
  <pre class="tool-fallback">{{ text }}</pre>
</template>

<style scoped>
.tool-fallback {
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text-secondary);
  background: var(--color-bg-code, rgba(0, 0, 0, 0.35));
  padding: 10px;
  border-radius: 8px;
  max-height: 280px;
  overflow-y: auto;
  font-family: 'Cascadia Code', Consolas, monospace;
}
</style>
