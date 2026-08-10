<!-- CreateGroupDialog.vue —— 创建群组弹窗 -->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useUiStore } from '@/stores/ui';
import { useGroupStore } from '@/stores/groups';
import { useAgentStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { groupApi } from '@/services/api';

const ui = useUiStore();
const groupStore = useGroupStore();
const agentStore = useAgentStore();
const chatStore = useChatStore();

const name = ref('');
const description = ref('');
const error = ref('');
const creating = ref(false);

/** 参与者选择（从 agent 列表勾选，至少 1 个） */
const selectedParticipants = ref<string[]>([]);

const availableAgents = computed(() =>
  agentStore.agents.filter(a => !a.virtual && a.id !== 'user')
);

function toggleParticipant(agentId: string) {
  const idx = selectedParticipants.value.indexOf(agentId);
  if (idx >= 0) selectedParticipants.value.splice(idx, 1);
  else selectedParticipants.value.push(agentId);
}

async function create() {
  if (!name.value.trim()) { error.value = '请输入群组名称'; return; }
  if (selectedParticipants.value.length === 0) { error.value = '请至少选择一位参与者'; return; }
  creating.value = true;
  error.value = '';
  try {
    const data = await groupApi.create({
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      participants: selectedParticipants.value,
    });
    ui.createGroupVisible = false;
    name.value = '';
    description.value = '';
    selectedParticipants.value = [];
    await groupStore.fetchGroups();
    chatStore.selectConversation({ kind: 'group', id: data.group_id });
  } catch (e: any) {
    error.value = e.message || '创建失败';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.createGroupVisible" class="modal-overlay" @click.self="ui.createGroupVisible = false">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">创建群组</span>
            <button class="modal-close" @click="ui.createGroupVisible = false">×</button>
          </div>
          <div class="modal-body">
            <label class="field-label">名称</label>
            <input v-model="name" type="text" class="field-input" placeholder="群组名称" />
            <label class="field-label">描述（可选）</label>
            <textarea v-model="description" class="field-input" rows="2" placeholder="群组描述" />

            <label class="field-label">参与者（已选 {{ selectedParticipants.length }}）</label>
            <div class="participant-list">
              <div
                v-for="agent in availableAgents"
                :key="agent.id"
                class="participant-item"
                :class="{ selected: selectedParticipants.includes(agent.id) }"
                @click="toggleParticipant(agent.id)"
              >
                <span class="participant-name">{{ agent.name }}</span>
                <svg v-if="selectedParticipants.includes(agent.id)" class="check-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
            </div>

            <div v-if="error" class="field-error">{{ error }}</div>
          </div>
          <div class="modal-footer">
            <button class="btn cancel" @click="ui.createGroupVisible = false">取消</button>
            <button class="btn primary" :disabled="creating" @click="create">{{ creating ? '创建中...' : '创建' }}</button>
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
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--color-text-primary); }
.modal-close { border: none; background: transparent; color: var(--color-text-tertiary); font-size: 20px; cursor: pointer; }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; color: var(--color-text-secondary); }
.field-input {
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: var(--color-bg-input, rgba(255, 255, 255, 0.04));
  color: var(--color-text-primary); font-size: 13px; font-family: inherit;
  resize: vertical;
}
.field-error { font-size: 12px; color: #e74c3c; }
.participant-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
  padding: 4px;
}
.participant-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.participant-item:hover { border-color: var(--color-primary, #6366f1); }
.participant-item.selected {
  border-color: var(--color-primary, #6366f1);
  background: var(--color-primary-soft, rgba(99, 102, 241, 0.12));
  color: var(--color-text-primary);
}
.check-icon { color: var(--color-primary, #6366f1); }
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
