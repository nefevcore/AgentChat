<!-- TokenUsage.vue —— Token 用量面板 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useUiStore } from '@/stores/ui';
import { usageApi } from '@/services/api';
import { formatNumber, formatRate } from '@/domain/format';

const ui = useUiStore();
const data = ref<any>(null);
const error = ref('');

async function load() {
  error.value = '';
  try {
    data.value = await usageApi.tokens();
  } catch (e: any) {
    error.value = e.message || '加载失败';
  }
}

onMounted(load);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.tokenUsageVisible" class="modal-overlay" @click.self="ui.tokenUsageVisible = false">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">Token 用量</span>
            <button class="modal-close" @click="ui.tokenUsageVisible = false">×</button>
          </div>
          <div class="modal-body">
            <div v-if="error" class="error">{{ error }}</div>
            <template v-else-if="data">
              <div class="stat-grid">
                <div class="stat">
                  <div class="stat-value">{{ formatNumber(data.totalTokens) }}</div>
                  <div class="stat-label">总 Token</div>
                </div>
                <div class="stat">
                  <div class="stat-value">{{ formatNumber(data.totalCost ? Math.round(data.totalCost * 100) / 100 : 0) }}</div>
                  <div class="stat-label">成本 ($)</div>
                </div>
                <div class="stat">
                  <div class="stat-value">{{ formatRate(data.cacheHitRate) }}</div>
                  <div class="stat-label">缓存命中率</div>
                </div>
              </div>
              <div v-if="data.perAgent" class="agent-table">
                <div class="table-row header">
                  <span>Agent</span><span>Token</span><span>占比</span>
                </div>
                <div v-for="a in data.perAgent" :key="a.agent_id" class="table-row">
                  <span>{{ a.name || a.agent_id }}</span>
                  <span>{{ formatNumber(a.tokens) }}</span>
                  <span>{{ formatRate(a.percent) }}</span>
                </div>
              </div>
            </template>
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
  width: min(560px, 90vw); max-height: 80vh;
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
.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
.stat {
  background: var(--color-bg-hover, rgba(255, 255, 255, 0.04));
  border-radius: 8px; padding: 12px; text-align: center;
}
.stat-value { font-size: 18px; font-weight: 700; color: var(--color-text-primary); }
.stat-label { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin-top: 4px; }
.agent-table { border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1)); border-radius: 8px; overflow: hidden; }
.table-row { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 6px 12px; font-size: 13px; }
.table-row.header { background: var(--color-bg-hover, rgba(255, 255, 255, 0.04)); font-weight: 600; color: var(--color-text-secondary); }
.table-row:not(.header) { color: var(--color-text-primary); }
.error { color: #e74c3c; font-size: 13px; }
.loading { color: var(--color-text-tertiary, #a8abb2); font-size: 13px; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
