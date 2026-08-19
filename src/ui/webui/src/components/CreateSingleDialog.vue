<script setup lang="ts">
// ============================================================
// CreateSingleDialog —— 新建独立会话（P3）
//
// 会话 = 引用 + 覆盖：选 Agent（引用，presets/工具/钩子跟随原定义）
// + 可选模型覆盖（池引用；缺省 = Agent 原配置）+ 可选标题。
// 每次新建都是干净上下文（历史/记忆与 pair 会话互不污染）。
// ============================================================
import { ref, onMounted } from 'vue';
import type { AgentInfo } from '../types';
import { VIEWER_ID } from '../constants';
import { fetchAgents, fetchPools } from '../core/api/endpoints/agents';
import { useSinglesStore } from '../stores/singles';
import { Modal } from '../ui';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const singlesStore = useSinglesStore();

const agents = ref<AgentInfo[]>([]);
const llmPools = ref<Record<string, Record<string, unknown>>>({});
const selectedAgent = ref('');
const selectedPool = ref('');
const title = ref('');
const error = ref('');
const loading = ref(false);

onMounted(async () => {
  try {
    const [agentData, poolData] = await Promise.all([fetchAgents(), fetchPools().catch(() => ({ llmProviders: {} }))]);
    // 过滤虚拟 Agent（user 等）——独立会话需要真实推理
    agents.value = (agentData.agents ?? []).filter((a: AgentInfo) => a.id !== VIEWER_ID.value && !a.virtual);
    llmPools.value = poolData.llmProviders ?? {};
  } catch { /* ignore */ }
});

async function create() {
  error.value = '';
  if (!selectedAgent.value) {
    error.value = '请选择一个 Agent';
    return;
  }
  loading.value = true;
  try {
    await singlesStore.create({
      agentId: selectedAgent.value,
      model: selectedPool.value || undefined,
      title: title.value.trim() || undefined,
    });
    emit('close');
  } catch (err: any) {
    error.value = `创建失败: ${err.message}`;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Modal :visible="true" :width="400" @close="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>新建独立会话</h3>
        <button class="close-btn" @click="emit('close')" title="关闭">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="form-group">
        <label>Agent</label>
        <select v-model="selectedAgent">
          <option value="" disabled>选择 Agent…</option>
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name || a.id }}</option>
        </select>
      </div>

      <div class="form-group">
        <label>模型 <span class="hint">（会话级覆盖，独立于 Agent 配置）</span></label>
        <select v-model="selectedPool">
          <option value="">默认（Agent 原配置）</option>
          <option v-for="(entry, name) in llmPools" :key="name" :value="name">
            {{ name }}{{ (entry as any).model && (entry as any).model !== name ? ' · ' + (entry as any).model : '' }}
          </option>
        </select>
      </div>

      <div class="form-group">
        <label>标题 <span class="hint">（可选）</span></label>
        <input v-model="title" type="text" placeholder="如：重构方案讨论" @keyup.enter="create" />
      </div>

      <p class="tip">每次新建会话都是干净上下文：历史与记忆互不污染，Agent 配置保持引用。</p>

      <div v-if="error" class="error-text">{{ error }}</div>

      <div class="dialog-actions">
        <button class="btn-cancel" :disabled="loading" @click="emit('close')">取消</button>
        <button class="btn-save" :disabled="loading" @click="create">{{ loading ? '创建中…' : '创建并进入' }}</button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog { padding: 20px 24px; }
.dialog-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.dialog-header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.close-btn { background: none; border: none; cursor: pointer; color: var(--color-text-secondary, #7f8c8d); padding: 4px; border-radius: 6px; line-height: 0; }
.close-btn:hover { background: var(--color-bg-hover, rgba(0,0,0,.06)); color: var(--color-text-primary); }
.form-group { margin-bottom: 12px; display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; font-weight: 500; color: var(--color-text-secondary, #7f8c8d); }
.form-group .hint { font-weight: 400; color: var(--color-text-tertiary, #a8abb2); }
.form-group select, .form-group input { padding: 7px 10px; border: 1px solid var(--color-border-secondary, #ddd); border-radius: 6px; font-size: 13px; background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50); outline: none; width: 100%; box-sizing: border-box; }
.form-group select:focus, .form-group input:focus { border-color: var(--color-primary, #6366f1); }
.tip { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin: 0 0 10px; line-height: 1.5; }
.error-text { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.btn-cancel, .btn-save { padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.btn-cancel { background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-save { background: var(--color-primary, #6366f1); border: none; color: #fff; }
.btn-save:hover:not(:disabled) { background: var(--color-primary-hover, #4f46e5); }
.btn-save:disabled, .btn-cancel:disabled { opacity: .6; cursor: not-allowed; }
</style>
