<script setup lang="ts">
import ScrollableViewport from '@/components/chat/ScrollableViewport.vue';
defineProps<{ data: Record<string, unknown> }>();
</script>

<template>
  <div class="tool-result-fallback">
    <ScrollableViewport><pre class="fallback-json"><code>{{ JSON.stringify(data, null, 2) }}</code></pre></ScrollableViewport>
  </div>
</template>

<style scoped>
.tool-result-fallback { padding: 4px 0; }
.fallback-json {
  margin: 0;
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  line-height: 1.6;
}
.fallback-json code {
  background: var(--color-bg-surface);
  padding: 10px 12px;
  border-radius: 6px;
  display: block;
  white-space: pre-wrap;
  word-break: break-word;


}
</style>
