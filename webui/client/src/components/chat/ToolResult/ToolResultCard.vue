<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const dataEntries = computed<[string, string][]>(() => {
  return Object.entries(props.data)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => [formatKey(k), String(v)]);
});

const isReload = computed(() => 'result' in props.data);

function formatKey(key: string): string {
  const map: Record<string, string> = {
    path: '路径',
    bytes_written: '写入字节',
    size: '文件大小',
    replacements: '替换处数',
    old_string: '原文本',
    new_string: '新文本',
    message: '消息',
    result: '结果',
  };
  return map[key] || key;
}
</script>

<template>
  <div class="tool-result-card">
    <div v-if="isReload" class="card-reload-result">{{ data.result }}</div>
    <div v-else class="card-kv-grid">
      <div v-for="([k, v]) in dataEntries" :key="k" class="card-kv-row">
        <span class="card-kv-key">{{ k }}</span>
        <span class="card-kv-value">{{ v }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-result-card { padding: 4px 0; }
.card-reload-result {
  font-size: 13px; color: var(--color-text-secondary);
  white-space: pre-wrap;
}
.card-kv-grid {
  display: flex; flex-direction: column; gap: 4px;
}
.card-kv-row {
  display: flex; align-items: baseline; gap: 8px;
  font-size: 13px; padding: 2px 0;
}
.card-kv-key {
  color: var(--color-text-tertiary);
  min-width: 80px; flex-shrink: 0;
}
.card-kv-value {
  color: var(--color-text-primary);
  font-family: 'SF Mono', 'Fira Code', monospace;
  word-break: break-all;
}
</style>
