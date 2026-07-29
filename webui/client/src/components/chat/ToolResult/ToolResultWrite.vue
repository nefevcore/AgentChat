<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ data: Record<string, unknown> }>();

const filePath = String(props.data.path || '');
const fileName = filePath.split(/[/\\]/).pop() || filePath;
const showModal = ref(false);
const content = ref('');
const loading = ref(false);
const error = ref('');

async function open() {
  showModal.value = true;
  if (content.value || error.value) return;
  loading.value = true;
  try {
    const resp = await fetch(`/api/browse/read-file?path=${encodeURIComponent(filePath)}`);
    const json = await resp.json();
    if (json.success) content.value = json.content;
    else error.value = json.error || '读取失败';
  } catch (e: any) { error.value = e.message; }
  finally { loading.value = false; }
}
</script>

<template>
  <span class="write-link" @click.stop="open" :title="filePath">{{ fileName }}</span>

  <Teleport to="body">
    <div v-if="showModal" class="w-modal-backdrop" @click.self="showModal = false">
      <div class="w-modal">
        <div class="w-modal-header">
          <span class="w-modal-title">{{ filePath }}</span>
          <button class="w-modal-close" @click="showModal = false">✕</button>
        </div>
        <div class="w-modal-body">
          <div v-if="loading" class="w-modal-msg">加载中...</div>
          <div v-else-if="error" class="w-modal-msg w-modal-err">{{ error }}</div>
          <pre v-else><code>{{ content }}</code></pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.write-link {
  font-size: 13px; color: var(--color-accent, #4a90d9); cursor: pointer;
  font-family: 'SF Mono', 'Consolas', monospace;
  text-decoration: underline; text-underline-offset: 2px;
}
.write-link:hover { opacity: 0.8; }

.w-modal-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.45); backdrop-filter: blur(4px);
}
.w-modal {
  background: var(--color-bg-primary); border-radius: 12px;
  width: min(90vw, 800px); max-height: 80vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
}
.w-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 18px; border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.w-modal-title {
  font-size: 13px; font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.w-modal-close {
  border: none; background: none; font-size: 18px;
  color: var(--color-text-tertiary); cursor: pointer;
}
.w-modal-close:hover { color: var(--color-text-primary); }
.w-modal-body { padding: 16px 18px; overflow: auto; flex: 1; }
.w-modal-body pre {
  margin: 0; font-size: 13px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  font-family: 'SF Mono', 'Consolas', monospace;
  color: var(--color-text-primary);
}
.w-modal-msg { font-size: 13px; color: var(--color-text-secondary); }
.w-modal-err { color: var(--color-error, #e74c3c); }
</style>
