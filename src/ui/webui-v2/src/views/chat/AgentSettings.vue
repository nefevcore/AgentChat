<!-- AgentSettings.vue —— Agent 配置弹窗（简化：展示+编辑 LLM/能力标签）
     完整 schema 编辑可后续通过注册表扩展。 -->
<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useUiStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import type { AgentFullConfig } from '@/domain/types';

const ui = useUiStore();
const agentStore = useAgentStore();

const form = ref<AgentFullConfig | null>(null);
const loading = ref(false);
const error = ref('');
const saved = ref(false);

const activeAgent = computed(() =>
  agentStore.agents.find(a => a.id === ui.settingsAgentId)
);

async function load() {
  if (!ui.settingsAgentId) return;
  loading.value = true;
  error.value = '';
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(ui.settingsAgentId)}/config`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    form.value = await resp.json();
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(() => [ui.agentSettingsVisible, ui.settingsAgentId], () => {
  if (ui.agentSettingsVisible) { saved.value = false; load(); }
});

async function save() {
  if (!form.value || !ui.settingsAgentId) return;
  saving.value = true;
  error.value = '';
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(ui.settingsAgentId)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form.value),
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
      <div v-if="ui.agentSettingsVisible" class="modal-overlay" @click.self="ui.agentSettingsVisible = false">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">Agent 配置 · {{ activeAgent?.name || ui.settingsAgentId }}</span>
            <button class="modal-close" @click="ui.agentSettingsVisible = false">×</button>
          </div>
          <div class="modal-body">
            <div v-if="loading" class="loading">加载中...</div>
            <div v-else-if="error && !form" class="error">{{ error }}</div>
            <template v-else-if="form">
              <label class="field-label">名称</label>
              <input v-model="form.name" type="text" class="field-input" />
              <label class="field-label">描述</label>
              <textarea v-model="form.description" class="field-input" rows="2" />
              <label class="field-label">能力标签（逗号分隔）</label>
              <input
                :value="(form.tags ?? []).join(', ')"
                class="field-input"
                @input="form.tags = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)"
              />
              <div v-if="error" class="field-error">{{ error }}</div>
              <div v-if="saved" class="saved-hint">✅ 已保存</div>
            </template>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="ui.agentSettingsVisible = false">关闭</button>
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
  width: min(520px, 90vw); max-height: 80vh;
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
.modal-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; color: var(--color-text-secondary); }
.field-input {
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: var(--color-bg-input, rgba(255, 255, 255, 0.04));
  color: var(--color-text-primary); font-size: 13px; font-family: inherit;
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
