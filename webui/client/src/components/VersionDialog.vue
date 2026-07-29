<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useMarkdown } from '@/composables/useMarkdown';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { render: renderMd } = useMarkdown();

const loading = ref(false);
const error = ref('');
const current = ref('');
const latest = ref('');
const hasUpdate = ref(false);
const latestUrl = ref('');
const changelog = ref('');
const updating = ref(false);
const updateMsg = ref('');

const renderedChangelog = computed(() => renderMd(changelog.value));

async function fetchVersion() {
  loading.value = true;
  error.value = '';
  try {
    const simulate = localStorage.getItem('agentchat.simulateUpdate') === '1';
    const url = simulate ? '/api/version?simulate=true' : '/api/version';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    current.value = data.current || '';
    latest.value = data.latest || '';
    hasUpdate.value = data.hasUpdate || false;
    latestUrl.value = data.latestUrl || '';

    // 同时拉 changelog
    try {
      const cr = await fetch('/api/version/changelog');
      if (cr.ok) {
        const cd = await cr.json();
        changelog.value = cd.content || '';
      }
    } catch { /* changelog 非关键 */ }
  } catch (err: any) {
    error.value = err.message || '获取版本信息失败';
  } finally {
    loading.value = false;
  }
}

watch(() => props.visible, (v) => {
  if (v) { current.value = ''; fetchVersion(); }
});

async function doUpdate() {
  updating.value = true;
  updateMsg.value = '正在更新...';
  try {
    const res = await fetch('/api/version/update', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      updateMsg.value = data.message;
      setTimeout(() => { window.location.reload(); }, 2000);
    } else {
      updateMsg.value = data.steps?.join(' | ') || data.message;
      updating.value = false;
    }
  } catch {
    updateMsg.value = '更新完成，刷新中...';
    setTimeout(() => { window.location.reload(); }, 1500);
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="visible" class="version-overlay" @mousedown.self="emit('close')">
      <div class="version-panel" @click.stop>
        <div class="panel-header">
          <h3>版本信息</h3>
          <button class="close-btn" @click="emit('close')" title="关闭">×</button>
        </div>
        <div class="panel-body">
          <div v-if="loading" class="status-msg">检查中...</div>
          <div v-else-if="error" class="status-msg error">{{ error }}</div>
          <template v-else>
            <!-- 版本对比 -->
            <div class="version-compare">
              <div class="version-card" :class="{ highlight: hasUpdate }">
                <div class="vc-label">当前版本</div>
                <div class="vc-version">v{{ current }}</div>
              </div>
              <div class="version-arrow">→</div>
              <div class="version-card latest">
                <div class="vc-label">最新版本</div>
                <div class="vc-version">{{ latest ? `v${latest}` : '未知' }}</div>
              </div>
            </div>

            <!-- 状态提示 -->
            <div v-if="hasUpdate" class="version-status update">
              <span class="version-status-icon">⬆</span>
              新版本可用！建议更新以获得最新功能和修复。
            </div>
            <div v-else class="version-status current">
              <span class="version-status-icon">✓</span>
              已是最新版本。
            </div>

            <!-- 更新按钮 -->
            <div v-if="hasUpdate" class="version-actions">
              <a v-if="latestUrl" :href="latestUrl" target="_blank" class="version-btn secondary">GitHub Release</a>
              <button class="version-btn primary" :disabled="updating" @click="doUpdate">
                {{ updating ? '更新中...' : '一键更新' }}
              </button>
            </div>
            <div v-if="updateMsg" class="version-update-msg">{{ updateMsg }}</div>

            <!-- 更新日志 -->
            <details v-if="changelog" class="version-changelog" open>
              <summary>更新日志</summary>
              <div class="markdown-body" v-html="renderedChangelog" />
            </details>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.version-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  z-index: 1001;
}
.version-panel {
  background: var(--color-bg-page, #fff);
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  border-radius: 10px;
  width: 700px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
}
.panel-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--color-border-secondary, #e0e0e0);
  flex-shrink: 0;
}
.panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.close-btn { margin-left: auto; background: none; border: none; color: var(--color-text-secondary, #7f8c8d); font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1; }
.close-btn:hover { color: var(--color-text-primary, #2c3e50); }
.panel-body { flex: 1; overflow-y: auto; padding: 20px; }

.status-msg { text-align: center; padding: 32px; color: var(--color-text-secondary, #999); font-size: 14px; }
.status-msg.error { color: #e74c3c; }

/* 版本对比卡片 */
.version-compare {
  display: flex; align-items: center; justify-content: center;
  gap: 16px; margin-bottom: 16px;
}
.version-card {
  text-align: center;
  padding: 12px 18px;
  border-radius: 8px;
  background: var(--color-bg-surface, #f8f8f8);
  border: 2px solid transparent;
  min-width: 100px;
}
.version-card.highlight {
  border-color: var(--color-border-secondary, #e0e0e0);
  opacity: 0.7;
}
.version-card.latest {
  border-color: var(--color-primary, #6366f1);
  background: var(--color-primary-light, rgba(99,102,241,0.06));
}
.vc-label { font-size: 11px; color: var(--color-text-tertiary, #a8abb2); margin-bottom: 4px; }
.vc-version { font-size: 18px; font-weight: 700; color: var(--color-text-primary, #2c3e50); }
.version-card.latest .vc-version { color: var(--color-primary, #6366f1); }
.version-arrow { font-size: 20px; color: var(--color-text-tertiary, #a8abb2); }

/* 状态提示 */
.version-status {
  text-align: center; padding: 8px 12px; border-radius: 6px;
  font-size: 13px; margin-bottom: 12px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.version-status.update {
  background: #fef3c7; color: #92400e;
}
.version-status.current {
  background: #ecfdf5; color: #065f46;
}
.version-status-icon { font-size: 14px; }

/* 操作按钮 */
.version-actions {
  display: flex; justify-content: center; gap: 10px;
  margin-bottom: 12px;
}
.version-btn {
  padding: 8px 20px; border-radius: 6px;
  font-size: 13px; font-weight: 500; cursor: pointer;
  border: 1px solid var(--color-border-secondary, #e0e0e0);
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary, #2c3e50);
  text-decoration: none; display: inline-block;
  transition: background 0.15s;
}
.version-btn.primary {
  background: var(--color-primary, #6366f1);
  color: #fff; border-color: var(--color-primary, #6366f1);
}
.version-btn.primary:hover { opacity: 0.9; }
.version-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.version-btn.secondary:hover { background: var(--color-bg-surface, #f5f5f5); }

.version-update-msg {
  text-align: center; padding: 8px;
  font-size: 12px; color: var(--color-text-tertiary, #a8abb2);
  white-space: pre-line;
}

/* 更新日志 */
.version-changelog {
  margin-top: 16px;
  border-top: 1px solid var(--color-border-secondary, #e0e0e0);
  padding-top: 12px;
}
.version-changelog summary {
  cursor: pointer; font-size: 13px; font-weight: 600;
  color: var(--color-text-secondary, #7f8c8d);
  padding: 4px 0;
}
.version-changelog .markdown-body {
  margin-top: 8px;
  font-size: 13px;
  max-height: 300px;
  overflow-y: auto;
}

/* Transition */
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-active .version-panel, .modal-leave-active .version-panel { transition: transform 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .version-panel { transform: scale(0.95); }
.modal-leave-to .version-panel { transform: scale(0.95); }
</style>
