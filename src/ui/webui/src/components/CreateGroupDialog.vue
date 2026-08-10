<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { AgentInfo } from '../types';
import { VIEWER_ID } from '../constants';
import { Modal } from '../ui';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created', groupId: string): void;
}>();

const groupId = ref('');
const groupName = ref('');
const groupDesc = ref('');
const selectedParticipants = ref<string[]>([]);
const error = ref('');
const loading = ref(false);
const agents = ref<AgentInfo[]>([]);

onMounted(async () => {
  try {
    const resp = await fetch('/api/agents');
    if (resp.ok) {
      const data = await resp.json();
      agents.value = (data.agents ?? []).filter((a: AgentInfo) => a.id !== VIEWER_ID.value);
    }
  } catch { /* ignore */ }
});

function toggleParticipant(agentId: string) {
  const idx = selectedParticipants.value.indexOf(agentId);
  if (idx === -1) {
    selectedParticipants.value.push(agentId);
  } else {
    selectedParticipants.value.splice(idx, 1);
  }
}

async function createGroup() {
  error.value = '';
  if (!groupName.value.trim()) {
    error.value = '请输入群组名称';
    return;
  }
  if (selectedParticipants.value.length === 0) {
    error.value = '请选择至少一个参与者';
    return;
  }

  loading.value = true;
  try {
    const body: Record<string, any> = {
      name: groupName.value.trim(),
      participants: selectedParticipants.value,
      description: groupDesc.value.trim() || undefined,
    };
    // group_id 可选：留空时后端自动生成 UUID
    const rid = groupId.value.trim();
    if (rid) body.group_id = rid;

    const resp = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      error.value = data.error || '创建失败';
      return;
    }
    emit('created', data.group.group_id);
    emit('close');
  } catch (err: any) {
    error.value = `创建失败: ${err.message}`;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Modal :visible="true" :width="420" @close="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>创建群聊群组</h3>
        <button class="close-btn" @click="emit('close')" title="关闭">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="dialog-body">
        <div class="form-group">
          <label>群组 ID <span class="optional-hint">（可选，留空自动生成）</span></label>
          <input v-model="groupId" type="text" placeholder="如：general，留空则自动生成 UUID" class="form-input" />
        </div>

        <div class="form-group">
          <label>群组名称</label>
          <input v-model="groupName" type="text" placeholder="如：综合讨论区" class="form-input" />
        </div>

        <div class="form-group">
          <label>描述（可选）</label>
          <input v-model="groupDesc" type="text" placeholder="群组描述" class="form-input" />
        </div>

        <div class="form-group">
          <div class="section-label">
            <span class="label-text">选择参与者</span>
            <span class="label-badge" v-if="selectedParticipants.length > 0">
              已选 {{ selectedParticipants.length }}
            </span>
          </div>
          <div class="participant-list" v-if="agents.length > 0">
            <label
              v-for="agent in agents"
              :key="agent.id"
              class="participant-item"
              :class="{ selected: selectedParticipants.includes(agent.id) }"
            >
              <div class="participant-check">
                <svg v-if="selectedParticipants.includes(agent.id)" class="check-icon" viewBox="0 0 24 24" width="18" height="18">
                  <circle cx="12" cy="12" r="10" fill="currentColor" />
                  <path d="M8 12l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
                </svg>
                <svg v-else class="check-icon unchecked" viewBox="0 0 24 24" width="18" height="18">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" />
                </svg>
              </div>
              <div class="participant-avatar">
                <img v-if="agent.avatar" :src="agent.avatar" :alt="agent.name" />
                <span v-else>{{ (agent.name || agent.id).charAt(0).toUpperCase() }}</span>
              </div>
              <div class="participant-info">
                <span class="participant-name">{{ agent.name || agent.id }}</span>
                <span class="participant-id">{{ agent.id }}</span>
              </div>
              <input
                type="checkbox"
                :checked="selectedParticipants.includes(agent.id)"
                @change="toggleParticipant(agent.id)"
                class="hidden-checkbox"
              />
            </label>
          </div>
          <div class="loading-hint" v-else>
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-text">正在加载 Agent 列表…</span>
          </div>
        </div>

        <div class="error" v-if="error">{{ error }}</div>
      </div>

      <div class="dialog-footer">
        <button class="btn-cancel" @click="emit('close')">取消</button>
        <button class="btn-create" @click="createGroup" :disabled="loading">
          {{ loading ? '创建中...' : '创建群组' }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border-secondary, rgba(255,255,255,0.06));
}
.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--color-text-primary, #e0e0e0);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px; height: 28px;
  border: none; border-radius: 4px;
  background: none;
  color: var(--color-text-tertiary, rgba(255,255,255,0.5));
  cursor: pointer;
}
.close-btn:hover { color: var(--color-text-primary, #fff); background: var(--color-bg-hover, rgba(255,255,255,0.08)); }

.dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group > label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(255,255,255,0.7));
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.12));
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-primary, #e0e0e0);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.form-input:focus { border-color: var(--color-primary, #4f46e5); }
.form-input::placeholder {
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
}

.section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 20px;
}

.label-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(255,255,255,0.7));
}

.label-badge {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-primary, #4f46e5);
  background: rgba(79,70,229,0.12);
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

.participant-list {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  overflow-y: scroll;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.09));
  border-radius: 8px;
}

.participant-list::-webkit-scrollbar {
  width: 6px;
}
.participant-list::-webkit-scrollbar-track {
  background: transparent;
}
.participant-list::-webkit-scrollbar-thumb {
  background: var(--color-border-primary, #bdc3c7);
  border-radius: 3px;
}
.participant-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-primary, #6366f1);
}

.participant-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition: background 0.15s ease;
  position: relative;
}
.participant-item::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 1px;
  background: var(--color-border-secondary, rgba(255,255,255,0.06));
}
.participant-item:last-child::after {
  display: none;
}
.participant-item:hover {
  background: var(--color-bg-hover, rgba(255,255,255,0.04));
  border-color: rgba(255,255,255,0.06);
}
.participant-item.selected {
  background: rgba(79,70,229,0.08);
  border-color: rgba(79,70,229,0.2);
}
.participant-item.selected:hover {
  background: rgba(79,70,229,0.12);
}

.hidden-checkbox {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  pointer-events: none;
}

.participant-check {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
}

.check-icon {
  color: var(--color-primary, #4f46e5);
  transition: transform 0.2s ease;
}
.check-icon.unchecked {
  color: var(--color-text-tertiary, rgba(255,255,255,0.35));
}
.participant-item.selected .check-icon {
  transform: scale(1.1);
}

.participant-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary, #4f46e5);
  background: var(--color-primary-light, rgba(79,70,229,0.12));
  flex-shrink: 0;
  overflow: hidden;
}
.participant-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.participant-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0px;
  min-width: 0;
  flex: 1;
  line-height: 1.4;
}

.participant-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--color-text-primary, #e0e0e0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.participant-id {
  font-size: 10.5px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.32));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.loading-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 20px 8px;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.08));
  border-radius: 8px;
  background: var(--color-bg-subtle, rgba(255,255,255,0.015));
}

.loading-text {
  font-size: 12px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.4));
  margin-left: 4px;
}

.loading-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255,255,255,0.3);
  animation: loadingBounce 1.4s ease-in-out infinite;
}
.loading-dot:nth-child(1) { animation-delay: 0s; }
.loading-dot:nth-child(2) { animation-delay: 0.2s; }
.loading-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes loadingBounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

.error {
  font-size: 13px;
  color: var(--color-error, #ef4444);
  padding: 8px 12px;
  border-radius: 4px;
  background: rgba(239,68,68,0.1);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--color-border-secondary, rgba(255,255,255,0.06));
}

.btn-cancel {
  padding: 7px 16px;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.15));
  border-radius: 6px;
  background: none;
  color: var(--color-text-secondary, rgba(255,255,255,0.7));
  font-size: 13px;
  cursor: pointer;
}
.btn-cancel:hover { background: var(--color-bg-hover, rgba(255,255,255,0.05)); }

.btn-create {
  padding: 7px 20px;
  border: none;
  border-radius: 6px;
  background: var(--color-primary, #4f46e5);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.btn-create:hover { opacity: 0.9; }
.btn-create:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
