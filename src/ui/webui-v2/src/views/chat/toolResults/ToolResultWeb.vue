<!-- ToolResultWeb.vue —— web_search / fetch 等网页类工具结果 -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: any; raw?: string }>();

const url = computed(() => props.data?.url ?? props.data?.link ?? '');
const title = computed(() => props.data?.title ?? props.data?.query ?? '');
const summary = computed(() => props.data?.summary ?? props.data?.snippet ?? props.data?.content ?? props.raw ?? '');
</script>

<template>
  <div class="tool-web">
    <div v-if="url" class="web-url">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
      <span>{{ url }}</span>
    </div>
    <div v-if="title" class="web-title">{{ title }}</div>
    <pre v-if="summary" class="web-summary">{{ summary }}</pre>
  </div>
</template>

<style scoped>
.tool-web {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.03));
}
.web-url {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-primary, #6366f1);
  word-break: break-all;
}
.web-title { font-size: 13px; font-weight: 600; color: var(--color-text-primary); margin-top: 6px; }
.web-summary {
  font-size: 12.5px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 6px;
  font-family: inherit;
}
</style>
