<!-- ChangelogDialog.vue —— 更新日志弹窗 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useUiStore } from '@/stores/ui';
import { versionApi } from '@/services/api';
import { useMarkdown } from '@/composables/useMarkdown';

const ui = useUiStore();
const { render } = useMarkdown();
const content = ref('');

onMounted(async () => {
  try {
    const data = await versionApi.changelog();
    content.value = typeof data === 'string' ? data : (data.changelog ?? data.content ?? '');
  } catch { /* ignore */ }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.changelogVisible" class="modal-overlay" @click.self="ui.changelogVisible = false">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">更新日志</span>
            <button class="modal-close" @click="ui.changelogVisible = false">×</button>
          </div>
          <div class="modal-body">
            <div v-if="content" v-html="render(content)" class="md-render" />
            <div v-else class="loading">加载中...</div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal-card {
  width: min(640px, 90vw); max-height: 80vh;
  background: var(--color-bg-panel, #1e1e22);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 12px; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--color-text-primary); }
.modal-close { border: none; background: transparent; color: var(--color-text-tertiary); font-size: 20px; cursor: pointer; }
.modal-body { padding: 16px; overflow-y: auto; }
.md-render :deep(pre) { background: var(--color-bg-code, rgba(0, 0, 0, 0.35)); border-radius: 6px; padding: 10px; overflow-x: auto; }
.md-render :deep(h1), .md-render :deep(h2), .md-render :deep(h3) { color: var(--color-text-primary); margin: 12px 0 8px; }
.md-render :deep(ul) { padding-left: 20px; }
.loading { color: var(--color-text-tertiary, #a8abb2); font-size: 13px; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
