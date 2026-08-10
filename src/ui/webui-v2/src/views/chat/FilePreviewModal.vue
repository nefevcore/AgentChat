<!-- FilePreviewModal.vue —— 工作区文件预览弹窗（全局单例） -->
<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useUiStore } from '@/stores/ui';
import { useMarkdown } from '@/composables/useMarkdown';
import { workspaceApi } from '@/services/api';
import { formatFileSize } from '@/domain/format';

const ui = useUiStore();
const { render } = useMarkdown();

const content = ref('');
const loading = ref(false);
const error = ref('');
const meta = ref<any>(null);

watch(() => ui.filePreviewVisible, async (visible) => {
  if (!visible) return;
  if (!ui.filePreviewPath) return;
  loading.value = true;
  error.value = '';
  content.value = '';
  meta.value = null;
  try {
    const data = await workspaceApi.file(ui.filePreviewPath);
    meta.value = data.meta ?? null;
    content.value = data.content ?? data.text ?? '';
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
});

const isCode = computed(() => {
  const ext = ui.filePreviewPath.split('.').pop()?.toLowerCase() || '';
  return /^(ts|js|tsx|jsx|vue|py|json|md|css|html|sh|bat|ps1|go|rs|java|c|h|cpp|hpp|sql|yml|yaml|xml|toml|ini|env)$/.test(ext);
});

const rendered = computed(() => {
  const ext = ui.filePreviewPath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') return render(content.value);
  return '';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.filePreviewVisible" class="modal-overlay" @click.self="ui.closePreview()">
        <div class="modal-card preview-card">
          <div class="modal-header">
            <span class="modal-title">{{ ui.filePreviewPath }}</span>
            <button class="modal-close" @click="ui.closePreview()">×</button>
          </div>
          <div class="modal-body">
            <div v-if="meta" class="file-meta">
              {{ meta.filename }} · {{ formatFileSize(meta.filesize ?? 0) }}
            </div>
            <div v-if="loading" class="loading">加载中...</div>
            <div v-else-if="error" class="error">{{ error }}</div>
            <div v-else-if="rendered" v-html="rendered" class="md-render" />
            <pre v-else class="code-block">{{ content }}</pre>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.modal-card {
  width: min(760px, 90vw);
  height: min(70vh, 600px);
  background: var(--color-bg-panel, #1e1e22);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}
.modal-title {
  font-size: 13px; color: var(--color-text-primary);
  font-family: 'Cascadia Code', Consolas, monospace;
  word-break: break-all;
}
.modal-close {
  border: none; background: transparent; color: var(--color-text-tertiary);
  font-size: 20px; cursor: pointer; line-height: 1;
}
.modal-body { flex: 1; overflow-y: auto; padding: 16px; }
.file-meta { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin-bottom: 8px; }
.loading, .error { color: var(--color-text-tertiary, #a8abb2); font-size: 13px; }
.error { color: #e74c3c; }
.code-block {
  font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
  color: var(--color-text-primary);
  font-family: 'Cascadia Code', Consolas, monospace;
  margin: 0;
}
.md-render :deep(pre) { background: var(--color-bg-code, rgba(0, 0, 0, 0.35)); border-radius: 6px; padding: 10px; overflow-x: auto; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
