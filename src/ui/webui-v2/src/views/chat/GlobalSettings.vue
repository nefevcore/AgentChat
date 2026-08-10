<!-- GlobalSettings.vue —— 全局配置弹窗（JSON 查看/编辑） -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useUiStore } from '@/stores/ui';
import { configApi } from '@/services/api';

const ui = useUiStore();
const config = ref<string>('');
const loading = ref(false);
const error = ref('');
const saved = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await configApi.get();
    config.value = JSON.stringify(data, null, 2);
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(() => ui.globalSettingsVisible, (v) => { if (v) load(); });

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const parsed = JSON.parse(config.value);
    const resp = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!resp.ok) { const d = await resp.json().catch(() => null); throw new Error(d?.error || `HTTP ${resp.status}`); }
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 2000);
  } catch (e: any) {
    error.value = e.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

const saving = ref(false);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.globalSettingsVisible" class="modal-overlay" @click.self="ui.globalSettingsVisible = false">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">全局配置</span>
            <button class="modal-close" @click="ui.globalSettingsVisible = false">×</button>
          </div>
          <div class="modal-body">
            <div v-if="loading" class="loading">加载中...</div>
            <div v-else-if="error && !config" class="error">{{ error }}</div>
            <template v-else>
              <textarea v-model="config" class="config-editor" spellcheck="false" />
              <div v-if="error" class="field-error">{{ error }}</div>
              <div v-if="saved" class="saved-hint">✅ 已保存</div>
            </template>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="ui.globalSettingsVisible = false">关闭</button>
            <button class="btn primary" :disabled="saving || loading" @click="save">{{ saving ? '保存中...' : '保存' }}</button>
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
  width: min(680px, 92vw); max-height: 85vh;
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
.modal-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.config-editor {
  flex: 1;
  min-height: 320px;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: var(--color-bg-code, rgba(0, 0, 0, 0.35));
  color: var(--color-text-primary);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  resize: vertical;
}
.field-error { font-size: 12px; color: #e74c3c; }
.saved-hint { font-size: 12px; color: #2ecc71; }
.loading, .error { color: var(--color-text-tertiary, #a8abb2); font-size: 13px; }
.error { color: #e74c3c; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}
.btn {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.15));
  background: transparent; color: var(--color-text-secondary);
  border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer;
}
.btn.primary { background: var(--color-primary, #6366f1); color: #fff; border-color: transparent; }
.btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
