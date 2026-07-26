<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { PluginMeta } from '../types';

const props = defineProps<{
  agentId: string;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const plugins = ref<PluginMeta[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');

/** 按类型分组 */
const toolPlugins = computed(() => plugins.value.filter(p => p.type === 'tool'));
const preHookPlugins = computed(() => plugins.value.filter(p => p.type === 'pre_hook'));
const postHookPlugins = computed(() => plugins.value.filter(p => p.type === 'post_hook'));

async function loadPlugins() {
  if (!props.agentId) return;
  loading.value = true;
  error.value = '';
  try {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(props.agentId)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    plugins.value = data.plugins ?? [];
  } catch (err: any) {
    error.value = `加载失败: ${err.message}`;
  } finally {
    loading.value = false;
  }
}

async function savePlugins() {
  saving.value = true;
  error.value = '';
  try {
    const enabledPlugins = plugins.value.map(p => ({
      name: p.name,
      type: p.type,
      enabled: p.enabled,
    }));
    const resp = await fetch(`/api/plugins/${encodeURIComponent(props.agentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledPlugins }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.success) {
      emit('saved');
      emit('close');
    } else {
      error.value = data.error ?? '保存失败';
    }
  } catch (err: any) {
    error.value = `保存失败: ${err.message}`;
  } finally {
    saving.value = false;
  }
}

function togglePlugin(plugin: PluginMeta) {
  plugin.enabled = !plugin.enabled;
}

/** 当 agentId 或 visible 变化时重新加载 */
watch(() => [props.agentId, props.visible] as const, ([id, vis]) => {
  if (id && vis) {
    loadPlugins();
  }
});

const typeLabels: Record<string, string> = {
  tool: '🔧 工具',
  pre_hook: '⚡ 前置钩子',
  post_hook: '📋 后置钩子',
};
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="plugin-overlay" @click.self="emit('close')">
      <div class="plugin-panel">
        <div class="panel-header">
          <h3>插件管理</h3>
          <span class="agent-label">{{ agentId }}</span>
          <button class="close-btn" @click="emit('close')" title="关闭">✕</button>
        </div>

        <div class="panel-body">
          <div v-if="loading" class="status-msg">加载中...</div>
          <div v-else-if="error" class="status-msg error">{{ error }}</div>

          <template v-else>
            <!-- 工具 -->
            <div v-if="toolPlugins.length > 0" class="plugin-group">
              <div class="group-title">{{ typeLabels.tool }} <span class="count">{{ toolPlugins.length }}</span></div>
              <label
                v-for="p in toolPlugins"
                :key="'tool:' + p.name"
                class="plugin-item"
              >
                <input type="checkbox" :checked="p.enabled" @change="togglePlugin(p)" />
                <div class="plugin-info">
                  <span class="plugin-name">{{ p.label || p.name }}</span>
                  <span class="plugin-desc">{{ p.description }}</span>
                </div>
              </label>
            </div>

            <!-- 前置钩子 -->
            <div v-if="preHookPlugins.length > 0" class="plugin-group">
              <div class="group-title">{{ typeLabels.pre_hook }} <span class="count">{{ preHookPlugins.length }}</span></div>
              <label
                v-for="p in preHookPlugins"
                :key="'pre:' + p.name"
                class="plugin-item"
              >
                <input type="checkbox" :checked="p.enabled" @change="togglePlugin(p)" />
                <div class="plugin-info">
                  <span class="plugin-name">{{ p.label || p.label || p.name }}</span>
                  <span class="plugin-desc">{{ p.description }}</span>
                </div>
              </label>
            </div>

            <!-- 后置钩子 -->
            <div v-if="postHookPlugins.length > 0" class="plugin-group">
              <div class="group-title">{{ typeLabels.post_hook }} <span class="count">{{ postHookPlugins.length }}</span></div>
              <label
                v-for="p in postHookPlugins"
                :key="'post:' + p.name"
                class="plugin-item"
              >
                <input type="checkbox" :checked="p.enabled" @change="togglePlugin(p)" />
                <div class="plugin-info">
                  <span class="plugin-name">{{ p.name }}</span>
                  <span class="plugin-desc">{{ p.description }}</span>
                </div>
              </label>
            </div>

            <div v-if="plugins.length === 0" class="status-msg">该 Agent 暂无可用插件</div>
          </template>
        </div>

        <div class="panel-footer">
          <span v-if="error" class="error-text">{{ error }}</span>
          <div class="footer-actions">
            <button class="btn-cancel" @click="emit('close')">取消</button>
            <button class="btn-save" :disabled="saving || loading" @click="savePlugins">
              {{ saving ? '保存中...' : '保存并重启' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.plugin-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.plugin-panel {
  background: var(--color-bg-page, #1e1e2e);
  border: 1px solid var(--color-border-secondary, #333);
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-secondary, #333);
}

.panel-header h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text-primary, #e0e0e0);
}

.agent-label {
  font-size: 12px;
  color: var(--color-text-tertiary, #888);
  background: var(--color-bg-subtle, #2a2a3a);
  padding: 2px 8px;
  border-radius: 4px;
}

.close-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--color-text-secondary, #999);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  color: var(--color-text-primary, #e0e0e0);
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px;
}

.status-msg {
  text-align: center;
  padding: 24px;
  color: var(--color-text-secondary, #999);
  font-size: 14px;
}

.status-msg.error {
  color: #e74c3c;
}

.plugin-group {
  margin-bottom: 20px;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary, #aaa);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.count {
  font-size: 11px;
  color: var(--color-text-tertiary, #777);
  font-weight: 400;
}

.plugin-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 4px;
}

.plugin-item:hover {
  background: var(--color-bg-subtle, #2a2a3a);
}

.plugin-item input[type="checkbox"] {
  margin-top: 2px;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: #6c5ce7;
}

.plugin-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.plugin-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary, #e0e0e0);
}

.plugin-desc {
  font-size: 12px;
  color: var(--color-text-tertiary, #888);
  line-height: 1.4;
}

.panel-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border-secondary, #333);
}

.error-text {
  font-size: 12px;
  color: #e74c3c;
  margin-right: auto;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.btn-cancel,
.btn-save {
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: opacity 0.15s;
}

.btn-cancel {
  background: var(--color-bg-subtle, #333);
  color: var(--color-text-secondary, #ccc);
}

.btn-cancel:hover {
  background: var(--color-bg-surface, #444);
}

.btn-save {
  background: #6c5ce7;
  color: #fff;
}

.btn-save:hover:not(:disabled) {
  background: #5b4cdb;
}

.btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 过渡动画 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-active .plugin-panel,
.modal-leave-active .plugin-panel {
  transition: transform 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .plugin-panel {
  transform: scale(0.95);
}
.modal-leave-to .plugin-panel {
  transform: scale(0.95);
}
</style>
