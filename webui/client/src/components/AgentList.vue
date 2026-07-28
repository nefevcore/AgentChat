<script setup lang="ts">
import { onMounted, inject, ref, computed } from 'vue';
import { useChatStore } from '../stores/chat';
import { useAgentStore } from '../stores/agents';
import { useWebSocketStore } from '../stores/websocket';
import type { AgentInfo } from '../types';

const chatStore = useChatStore();
const agentStore = useAgentStore();
const wsStore = useWebSocketStore();

const closeSidebar = inject<() => void>('closeSidebar', () => {});

/** 搜索文本 */
const searchQuery = ref('');
/** 新增 Agent 对话框 */
const showAddDialog = ref(false);
const newAgentId = ref('');
const newAgentName = ref('');
const selectedLlmPool = ref('');
const llmPools = ref<Record<string, Record<string, unknown>>>({});
const addError = ref('');

async function openAddDialog() {
  showAddDialog.value = true;
  selectedLlmPool.value = '';
  // 加载 LLM 池条目
  if (Object.keys(llmPools.value).length === 0) {
    try {
      const r = await fetch('/api/config/pools');
      if (r.ok) {
        const data = await r.json();
        llmPools.value = data.llmProviders ?? {};
      }
    } catch { /* ignore */ }
  }
}

const filteredAgents = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return agentStore.agents;
  return agentStore.agents.filter(a =>
    (a.id || '').toLowerCase().includes(q) ||
    (a.name || '').toLowerCase().includes(q)
  );
});

/** 有未读虚拟 Agent 消息的 Agent ID */
const unreadAgents = computed(() => chatStore.unreadAgents);

onMounted(() => {
  agentStore.requestAgents();
});

function selectAndClose(id: string) {
  agentStore.selectAgent(id);
  chatStore.loadHistory('user', id);
  const a = agentStore.agents.find(a => a.id === id);
  if (a?.hasActiveSession) wsStore.send('chat.subscribe', { to: id });
  closeSidebar();
}

function formatLastMessage(lastMessage: AgentInfo['lastMessage']): string {
  if (!lastMessage || !lastMessage.content) return '';
  const prefix = lastMessage.agent_id === 'user' ? '你: ' : '';
  return prefix + lastMessage.content;
}

async function createAgent() {
  addError.value = '';
  const id = newAgentId.value.trim();
  // ID 可选：留空时后端自动生成 UUID
  try {
    const body: Record<string, any> = {};
    if (id) body.id = id;
    if (newAgentName.value.trim()) body.name = newAgentName.value.trim();
    if (selectedLlmPool.value) {
      // 引用 LLM 池条目：发送 $ref + 池字段（与 AgentSettings 的保存逻辑一致）
      const pool = llmPools.value[selectedLlmPool.value];
      if (pool) {
        const poolData: Record<string, any> = { $ref: selectedLlmPool.value };
        for (const [k, v] of Object.entries(pool)) {
          if (k !== '$ref' && k !== '$comment' && !k.startsWith('$')) {
            poolData[k] = v;
          }
        }
        body.llm = poolData;
      }
    }
    const resp = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) { addError.value = data.error || '创建失败'; return; }
    showAddDialog.value = false;
    newAgentId.value = '';
    newAgentName.value = '';
    addError.value = '';
    agentStore.requestAgents();
  } catch (err: any) {
    addError.value = `创建失败: ${err.message}`;
  }
}
</script>

<template>
  <div class="agent-list">
    <div class="header">
      <div class="search-box">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="搜索 Agent..."
        />
      </div>
      <button class="add-btn" @click="openAddDialog" title="新增 Agent">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button class="mobile-close-btn" @click="closeSidebar" title="关闭菜单">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div class="agents">
      <div
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="agent-item"
        :class="{ active: agentStore.activeAgentId === agent.id }"
        @click="selectAndClose(agent.id)"
      >
        <div class="agent-avatar">
          <img v-if="agent.avatar" :src="agent.avatar" :alt="agent.name" />
          <div v-else class="avatar-placeholder">{{ (agent.name || agent.id).charAt(0).toUpperCase() }}</div>
          <span v-if="unreadAgents.has(agent.id)" class="unread-dot" />
        </div>
        <div class="agent-info">
          <div class="agent-name">{{ agent.name || agent.id }}</div>
          <div class="agent-last-msg">{{ formatLastMessage(agent.lastMessage) }}</div>
        </div>
      </div>
      <div v-if="filteredAgents.length === 0 && agentStore.agents.length > 0" class="empty">
        无匹配的 Agent
      </div>
      <div v-else-if="agentStore.agents.length === 0" class="empty">
        暂无可用的 Agent
      </div>
    </div>

    <!-- 新增 Agent 对话框 -->
    <Transition name="modal">
      <div v-if="showAddDialog" class="dialog-overlay" @mousedown.self="showAddDialog = false">
        <div class="dialog-panel" @click.stop>
          <h4>新增 Agent</h4>
          <div class="form-group">
            <label>Agent ID <span class="optional-hint">（可选，留空自动生成）</span></label>
            <input v-model="newAgentId" type="text" placeholder="如 my_agent，留空则自动生成 UUID" @keyup.enter="createAgent" />
          </div>
          <div class="form-group">
            <label>显示名称</label>
            <input v-model="newAgentName" type="text" placeholder="如 我的助手" @keyup.enter="createAgent" />
          </div>
          <div class="form-group">
            <label>模型</label>
            <select v-model="selectedLlmPool">
              <option value="">默认（全局配置）</option>
              <option v-for="(entry, name) in llmPools" :key="name" :value="name">{{ name }}{{ (entry as any).model && (entry as any).model !== name ? ' · ' + (entry as any).model : '' }}</option>
            </select>
          </div>
          <p v-if="!selectedLlmPool" class="default-hint">将使用全局默认模型配置</p>
          <div v-if="addError" class="error-text">{{ addError }}</div>
          <div class="dialog-actions">
            <button class="btn-cancel" @click="showAddDialog = false">取消</button>
            <button class="btn-save" @click="createAgent">创建</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.agent-list {
  flex: 1;
  min-width: 0;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border-secondary);
  display: flex;
  flex-direction: column;
  z-index: 210;
  transition: transform 0.25s ease;
}

.header {
  height: var(--layout-header-height);
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--color-border-secondary);
  flex-shrink: 0;
}

/* 搜索框 */
.search-box {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 8px;
  color: var(--color-text-tertiary, #a8abb2);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 5px 8px 5px 28px;
  border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 6px;
  background: var(--color-bg-page, #fff);
  color: var(--color-text-primary, #2c3e50);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus {
  border-color: var(--color-primary, #6366f1);
}
.search-input::placeholder {
  color: var(--color-text-tertiary, #a8abb2);
}

/* 新增按钮 */
.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--color-text-secondary, #7f8c8d);
  cursor: pointer;
  flex-shrink: 0;
}
.add-btn:hover {
  background: var(--color-bg-page, #fff);
  color: var(--color-primary, #6366f1);
}

/* 移动端关闭按钮：默认隐藏 */
.mobile-close-btn {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 4px;
  border-radius: var(--radius-sm);
  line-height: 0;
}

.mobile-close-btn:hover {
  background: var(--color-bg-subtle);
  color: var(--color-text-primary);
}

.agents {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-sm);
}

.agent-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: var(--space-xs);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  border: 1px solid transparent;
  gap: 10px;
}

.agent-avatar {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}
.unread-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ef4444;
  border: 2px solid var(--color-bg-surface, #fff);
}
.agent-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  color: var(--color-primary, #4f46e5);
  font-size: 15px;
  font-weight: 600;
}

.agent-item:hover {
  background: var(--color-bg-page);
  border-color: var(--color-border-secondary);
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-item:hover {
  background: var(--color-bg-page);
  border-color: var(--color-border-secondary);
}

.agent-item.active {
  background: var(--color-primary-light);
  border: 1px solid var(--color-primary);
}

.agent-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 19px;
  margin-bottom: 2px;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-last-msg {
  font-size: 11px;
  line-height: 19px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: var(--space-lg);
  text-align: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

/* 新增 Agent 对话框 */
.dialog-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center; z-index: 600;
}
.dialog-panel {
  background: var(--color-bg-page, #fff);
  border-radius: 10px; padding: 20px 24px;
  width: 360px; max-width: 90vw; max-height: 85vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}
.dialog-panel h4 { margin: 0 0 14px; font-size: 15px; font-weight: 600; color: var(--color-text-primary, #2c3e50); }
.dialog-panel .form-group { margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; }
.dialog-panel label { font-size: 12px; font-weight: 500; color: var(--color-text-secondary, #7f8c8d); }
.dialog-panel input, .dialog-panel select, .dialog-panel .add-field-input {
  padding: 7px 10px; border: 1px solid var(--color-border-secondary, #ddd);
  border-radius: 6px; font-size: 13px;
  background: var(--color-bg-page, #fff); color: var(--color-text-primary, #2c3e50);
  outline: none;
  width: 100%; box-sizing: border-box;
}
.dialog-panel input:focus, .dialog-panel select:focus, .dialog-panel .add-field-input:focus { border-color: var(--color-primary, #6366f1); }
.default-hint { font-size: 12px; color: var(--color-text-tertiary, #a8abb2); margin: -4px 0 4px; font-style: italic; }
.error-text { font-size: 12px; color: #e74c3c; margin-bottom: 8px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.btn-cancel, .btn-save { padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.btn-cancel { background: var(--color-bg-page, #fff); border: 1px solid var(--color-border-secondary, #ddd); color: var(--color-text-secondary, #7f8c8d); }
.btn-save { background: var(--color-primary, #6366f1); border: none; color: #fff; }
.btn-save:hover { background: var(--color-primary-hover, #4f46e5); }
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

/* ===== 响应式：窄屏 (≤768px) ===== */
@media (max-width: 768px) {
  .agent-list {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(280px, 80vw);
    transform: translateX(-100%);
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.15);
  }

  /* 展开状态 */
  .agent-list.sidebar-mobile-visible {
    transform: translateX(0);
  }

  .mobile-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
