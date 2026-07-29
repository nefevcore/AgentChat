<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const filePath = String(props.data.path || '');
const fileName = filePath.split(/[/\\]/).pop() || filePath;
const content = ref('');
const loading = ref(false);
const error = ref('');
const expanded = ref(false);

async function toggle() {
  if (expanded.value) { expanded.value = false; return; }
  expanded.value = true;
  if (content.value || error.value) return; // already loaded
  loading.value = true;
  try {
    const res = await fetch(`/api/browse/read-file?path=${encodeURIComponent(filePath)}`);
    const json = await res.json();
    if (json.success) content.value = json.content;
    else error.value = json.error || '读取失败';
  } catch (e: any) {
    error.value = e.message || '网络错误';
  } finally { loading.value = false; }
}
</script>

<template>
  <div class="tool-result-write">
    <span class="write-link" @click.stop="toggle" :title="filePath">
      {{ fileName }}
      <span class="write-chevron" :class="{ open: expanded }">▸</span>
    </span>
    <div v-if="expanded" class="write-content">
      <div v-if="loading" class="write-loading">加载中...</div>
      <div v-else-if="error" class="write-error">{{ error }}</div>
      <pre v-else><code>{{ content }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.tool-result-write {
  padding: 2px 0;
}
.write-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--color-accent, #4a90d9);
  cursor: pointer;
  font-family: 'SF Mono', 'Consolas', monospace;
  text-decoration: underline;
  text-underline-offset: 2px;
  user-select: none;
}
.write-link:hover {
  opacity: 0.8;
}
.write-chevron {
  font-size: 10px;
  transition: transform 0.2s;
  text-decoration: none;
}
.write-chevron.open {
  transform: rotate(90deg);
}
.write-content {
  margin-top: 6px;
  padding-left: 8px;
  border-left: 2px solid var(--color-border);
}
.write-content pre {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-secondary);
  max-height: 400px;
  overflow: auto;
  background: var(--color-code-bg, #f8f9fa);
  border-radius: 6px;
  padding: 10px 14px;
}
.write-content pre code {
  font-family: inherit;
  color: inherit;
}
.write-loading,
.write-error {
  font-size: 12px;
  color: var(--color-text-tertiary);
}
.write-error {
  color: var(--color-error, #e74c3c);
}
</style>
