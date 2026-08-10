<!-- ToolResultBrowser.vue —— browser 截图/页面状态 -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: any; raw?: string }>();

const url = computed(() => props.data?.url ?? '');
const screenshot = computed(() => props.data?.screenshot ?? props.data?.image ?? '');
const status = computed(() => props.data?.statusText ?? props.data?.status ?? '');
const content = computed(() => props.data?.content ?? props.data?.text ?? props.raw ?? '');
</script>

<template>
  <div class="tool-browser">
    <div v-if="url" class="browser-url">{{ url }}</div>
    <div v-if="status" class="browser-status">{{ status }}</div>
    <img v-if="screenshot" :src="screenshot" class="browser-shot" alt="screenshot" />
    <pre v-if="content" class="browser-content">{{ content }}</pre>
  </div>
</template>

<style scoped>
.tool-browser {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
}
.browser-url { font-size: 12px; color: var(--color-primary, #6366f1); word-break: break-all; }
.browser-status { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin-top: 4px; }
.browser-shot {
  margin-top: 8px;
  max-width: 100%;
  border-radius: 6px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
}
.browser-content {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
  font-family: inherit;
}
</style>
