<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const filePath = String(props.data.path || '');
const fileSize = Number(props.data.size || props.data.bytes_written || 0);
const showModal = ref(false);
const content = ref('');
const loading = ref(false);
const error = ref('');

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function viewContent() {
  if (!filePath) return;
  showModal.value = true;
  if (content.value || error.value) return; // already loaded
  loading.value = true;
  try {
    const res = await fetch(`/api/browse/read-file?path=${encodeURIComponent(filePath)}`);
    const json = await res.json();
    if (json.success) {
      content.value = json.content;
    } else {
      error.value = json.error || '读取失败';
    }
  } catch (e: any) {
    error.value = e.message || '网络错误';
  } finally {
    loading.value = false;
  }
}

function closeModal() {
  showModal.value = false;
}
</script>

<template>
  <div class="tool-result-write">
    <div class="write-info">
      <span class="write-path" :title="filePath">{{ filePath }}</span>
      <span class="write-size">{{ formatSize(fileSize) }}</span>
      <button class="write-view-btn" @click="viewContent">查看内容</button>
    </div>

    <!-- Modal overlay -->
    <Teleport to="body">
      <div v-if="showModal" class="write-modal-backdrop" @click.self="closeModal">
        <div class="write-modal">
          <div class="write-modal-header">
            <span class="write-modal-title">{{ filePath }}</span>
            <button class="write-modal-close" @click="closeModal">✕</button>
          </div>
          <div class="write-modal-body">
            <div v-if="loading" class="write-modal-loading">加载中...</div>
            <div v-else-if="error" class="write-modal-error">{{ error }}</div>
            <pre v-else><code>{{ content }}</code></pre>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tool-result-write {
  padding: 4px 0;
}

.write-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.write-path {
  color: var(--color-text-primary);
  font-family: 'SF Mono', 'Consolas', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.write-size {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.write-view-btn {
  flex-shrink: 0;
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid var(--color-border, #dfe6e9);
  border-radius: 4px;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.write-view-btn:hover {
  background: var(--color-accent);
  color: #fff;
  border-color: var(--color-accent);
}

/* ---- Modal ---- */
.write-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

.write-modal {
  background: var(--color-bg-primary);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  width: min(90vw, 800px);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.write-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.write-modal-title {
  font-size: 13px;
  font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.write-modal-close {
  border: none;
  background: none;
  font-size: 18px;
  color: var(--color-text-tertiary);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.write-modal-close:hover {
  color: var(--color-text-primary);
}

.write-modal-body {
  padding: 16px 18px;
  overflow: auto;
  flex: 1;
}

.write-modal-body pre {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-primary);
  background: transparent;
}

.write-modal-body pre code {
  font-family: inherit;
  color: inherit;
}

.write-modal-loading,
.write-modal-error {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.write-modal-error {
  color: var(--color-error, #e74c3c);
}
</style>
