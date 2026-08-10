<!-- VersionDialog.vue —— 版本信息弹窗 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useUiStore } from '@/stores/ui';
import { versionApi } from '@/services/api';

const ui = useUiStore();
const version = ref<any>(null);

onMounted(async () => {
  try { version.value = await versionApi.get(); } catch { /* ignore */ }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.versionVisible" class="modal-overlay" @click.self="ui.versionVisible = false">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">关于 AgentChat</span>
            <button class="modal-close" @click="ui.versionVisible = false">×</button>
          </div>
          <div class="modal-body">
            <div class="version-title">AgentChat v2</div>
            <div v-if="version" class="version-info">
              <div>后端版本：{{ version.version || version.latest?.version || '未知' }}</div>
              <button class="changelog-btn" @click="ui.changelogVisible = true; ui.versionVisible = false">查看更新日志</button>
            </div>
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
  width: min(440px, 90vw);
  background: var(--color-bg-panel, #1e1e22);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--color-text-primary); }
.modal-close { border: none; background: transparent; color: var(--color-text-tertiary); font-size: 20px; cursor: pointer; }
.modal-body { padding: 16px; }
.version-title { font-size: 16px; font-weight: 700; color: var(--color-text-primary); margin-bottom: 8px; }
.version-info { font-size: 13px; color: var(--color-text-secondary); display: flex; flex-direction: column; gap: 8px; }
.changelog-btn {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  background: transparent; color: var(--color-text-secondary);
  border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  width: fit-content;
}
.changelog-btn:hover { color: var(--color-text-primary); }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
