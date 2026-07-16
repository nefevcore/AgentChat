<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { AgentInfo } from '../types';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created', roomId: string): void;
}>();

const roomId = ref('');
const roomName = ref('');
const roomDesc = ref('');
const selectedParticipants = ref<string[]>([]);
const error = ref('');
const loading = ref(false);
const agents = ref<AgentInfo[]>([]);

onMounted(async () => {
  try {
    const resp = await fetch('/api/agents');
    if (resp.ok) {
      const data = await resp.json();
      agents.value = (data.agents ?? []).filter((a: AgentInfo) => a.id !== 'user');
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

async function createRoom() {
  error.value = '';
  if (!roomId.value.trim()) {
    error.value = '请输入房间 ID';
    return;
  }
  if (!roomName.value.trim()) {
    error.value = '请输入房间名称';
    return;
  }
  if (selectedParticipants.value.length === 0) {
    error.value = '请选择至少一个参与者';
    return;
  }

  loading.value = true;
  try {
    const resp = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: roomId.value.trim(),
        name: roomName.value.trim(),
        participants: selectedParticipants.value,
        description: roomDesc.value.trim() || undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      error.value = data.error || '创建失败';
      return;
    }
    emit('created', data.room.room_id);
    emit('close');
  } catch (err: any) {
    error.value = `创建失败: ${err.message}`;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="dialog-overlay" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>创建群聊房间</h3>
        <button class="close-btn" @click="emit('close')" title="关闭">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="dialog-body">
        <div class="form-group">
          <label>房间 ID</label>
          <input v-model="roomId" type="text" placeholder="如：general" class="form-input" />
        </div>

        <div class="form-group">
          <label>房间名称</label>
          <input v-model="roomName" type="text" placeholder="如：综合讨论区" class="form-input" />
        </div>

        <div class="form-group">
          <label>描述（可选）</label>
          <input v-model="roomDesc" type="text" placeholder="房间描述" class="form-input" />
        </div>

        <div class="form-group">
          <label>选择参与者</label>
          <div class="participant-list" v-if="agents.length > 0">
            <label
              v-for="agent in agents"
              :key="agent.id"
              class="participant-item"
              :class="{ selected: selectedParticipants.includes(agent.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedParticipants.includes(agent.id)"
                @change="toggleParticipant(agent.id)"
              />
              <span class="participant-name">{{ agent.name || agent.id }}</span>
              <span class="participant-id">{{ agent.id }}</span>
            </label>
          </div>
          <p class="hint" v-else>正在加载 Agent 列表…</p>
        </div>

        <div class="error" v-if="error">{{ error }}</div>
      </div>

      <div class="dialog-footer">
        <button class="btn-cancel" @click="emit('close')">取消</button>
        <button class="btn-create" @click="createRoom" :disabled="loading">
          {{ loading ? '创建中...' : '创建房间' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.dialog {
  width: 420px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--color-bg-secondary, #1e1e2e);
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.1));
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
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

.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, rgba(255,255,255,0.7));
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.1));
  border-radius: 6px;
  background: var(--color-bg-tertiary, #2a2a3a);
  color: var(--color-text-primary, #e0e0e0);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.form-input:focus { border-color: var(--color-primary, #4f46e5); }

.participant-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--color-border-secondary, rgba(255,255,255,0.08));
  border-radius: 6px;
  padding: 4px;
}

.participant-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}
.participant-item:hover { background: var(--color-bg-hover, rgba(255,255,255,0.05)); }
.participant-item.selected { background: var(--color-bg-active, rgba(79,70,229,0.1)); }

.participant-item input[type="checkbox"] {
  accent-color: var(--color-primary, #4f46e5);
}

.participant-name {
  font-size: 13px;
  color: var(--color-text-primary, #e0e0e0);
}

.participant-id {
  font-size: 11px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.4));
  margin-left: auto;
}

.hint {
  font-size: 12px;
  color: var(--color-text-tertiary, rgba(255,255,255,0.4));
  margin: 0;
  padding: 8px;
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
