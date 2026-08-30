<script setup lang="ts">
// ============================================================
// components/dialog/GroupDrawer.vue —— 群聊信息抽屉（成员/名称/简介/删除）
// 从 DialogView 拆分，降低主视图体积。
// ============================================================

import { ref, computed, watch } from 'vue';
import type { GroupInfo } from '../../types';
import { VIEWER_ID } from '../../constants';
import { updateGroup } from '../../core/api/endpoints/groups';
import { useAgentStore } from '../../stores/agents';
import { useGroupsStore } from '../../stores/groups';
import { Avatar } from '../../ui';

const props = defineProps<{
  group: GroupInfo;
  visible: boolean;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'deleteGroup', groupId: string): void;
}>();

const agentStore = useAgentStore();
const groupsStore = useGroupsStore();

const editingName = ref('');
const editingDescription = ref('');
const memberSearchQuery = ref('');
const renameError = ref('');
const renameSaved = ref(false);
const saving = ref(false);

function getMemberAvatar(agentId: string): string | undefined {
  return agentStore.getAgentAvatar(agentId) || undefined;
}
function getMemberName(agentId: string): string {
  return agentStore.getAgentName(agentId) || agentId;
}

const filteredParticipants = computed(() => {
  const q = memberSearchQuery.value.toLowerCase().trim();
  if (!q) return props.group.participants ?? [];
  return (props.group.participants ?? []).filter(p => p.toLowerCase().includes(q));
});

const memberItems = computed(() =>
  filteredParticipants.value.map(id => ({
    id,
    name: getMemberName(id),
    avatar: getMemberAvatar(id) ?? null,
    isViewer: id === VIEWER_ID.value,
  }))
);

/** 打开（或切换群组）时初始化编辑字段——此前初始化函数从未被调用，
 *  名称输入框永远为空、保存按钮恒禁用 */
watch(() => [props.visible, props.group.group_id] as const, ([v]) => {
  if (!v) return;
  editingName.value = props.group.name ?? '';
  editingDescription.value = props.group.description ?? '';
  memberSearchQuery.value = '';
  renameError.value = '';
}, { immediate: true });

async function saveGroupInfo() {
  if (saving.value || !editingName.value.trim()) return;
  saving.value = true;
  renameError.value = '';
  renameSaved.value = false;
  try {
    const body: Record<string, string> = { name: editingName.value.trim() };
    if (editingDescription.value !== (props.group.description ?? '')) {
      body.description = editingDescription.value;
    }
    await updateGroup(props.group.group_id, body);
    // 本地回写（名称此前不回写，标题/列表残留旧名）+ 刷新列表保持一致
    props.group.name = editingName.value.trim();
    props.group.description = editingDescription.value;
    void groupsStore.fetchGroups();
    renameSaved.value = true;
    setTimeout(() => { renameSaved.value = false; }, 2000);
  } catch (err: any) {
    renameError.value = `保存失败: ${err.message}`;
  } finally {
    saving.value = false;
  }
}
// 退出群聊：后端尚无对应契约（WS_SEND 无 group.leave），功能入口已移除
</script>

<template>
  <div v-if="visible" class="drawer-panel" @click.stop>
    <div class="drawer-section">
      <div class="drawer-section-title">群成员 ({{ props.group.participants.length }})</div>
      <div class="drawer-search-box">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input v-model="memberSearchQuery" type="text" class="drawer-search-input" placeholder="搜索成员..." />
      </div>
      <div class="drawer-member-list">
        <div v-for="m in memberItems" :key="m.id" class="drawer-member-item" :title="m.id">
          <div class="member-avatar-wrap">
            <Avatar :src="m.avatar" :name="m.name" :size="40" shape="circle" />
            <span v-if="m.isViewer" class="member-me">我</span>
          </div>
          <span class="member-name" :title="m.name">{{ m.name }}</span>
        </div>
        <div v-if="memberItems.length === 0" class="drawer-empty">未找到匹配的成员</div>
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">群聊名称</div>
      <div class="drawer-name-row">
        <input v-model="editingName" type="text" class="drawer-name-input" placeholder="输入群聊名称..." @keyup.enter="saveGroupInfo" />
        <button class="drawer-save-btn" :class="{ saved: renameSaved }" @click="saveGroupInfo" :disabled="saving || !editingName.trim() || editingName === props.group.name">{{ renameSaved ? '已保存' : '保存' }}</button>
      </div>
      <div v-if="renameError" class="drawer-error">{{ renameError }}</div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">群聊简介</div>
      <textarea v-model="editingDescription" class="drawer-desc-input" placeholder="添加群聊简介..." rows="3"></textarea>
    </div>

    <div class="drawer-section drawer-section-bottom">
      <button class="drawer-delete-btn" @click="emit('deleteGroup', props.group.group_id)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
        删除群组
      </button>
    </div>
  </div>
</template>

<style scoped>
.drawer-panel {
  width: 280px; flex-shrink: 0; border-left: 1px solid var(--color-border-secondary);
  background: var(--color-bg-surface); display: flex; flex-direction: column;
  overflow-y: auto;
}
.drawer-section { padding: 14px 16px; border-bottom: 1px solid var(--color-border-secondary); }
.drawer-section-title { font-size: 13px; font-weight: 600; color: var(--color-text-primary); margin-bottom: 8px; }
.drawer-search-box { position: relative; display: flex; align-items: center; margin-bottom: 8px; }
.drawer-search-box .search-icon { position: absolute; left: 8px; color: var(--color-text-tertiary); pointer-events: none; }
.drawer-search-input { width: 100%; padding: 5px 8px 5px 28px; border: 1px solid var(--color-border-secondary); border-radius: 6px; font-size: 12px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none; }
.drawer-search-input:focus { border-color: var(--color-primary); }
.drawer-member-list { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 4px; max-height: 320px; overflow-y: auto; padding: 4px 0; }
.drawer-member-item { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 2px; border-radius: 8px; cursor: default; min-width: 0; transition: background 0.15s ease; }
.drawer-member-item:hover { background: var(--color-bg-hover, rgba(0,0,0,0.04)); }
.member-avatar-wrap { position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: center; line-height: 0; }
.member-me { position: absolute; right: -5px; bottom: -3px; font-size: 9px; font-weight: 600; color: #fff; line-height: 14px; padding: 0 4px; border-radius: 8px; background: var(--color-primary, #6366f1); border: 1.5px solid var(--color-bg-surface); }
.member-name { font-size: 11px; color: var(--color-text-primary); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; max-width: 100%; margin-top: 2px; }
.drawer-empty { padding: 12px 0; font-size: 12px; color: var(--color-text-tertiary); text-align: center; }
.drawer-name-row { display: flex; gap: 6px; }
.drawer-name-input { flex: 1; padding: 6px 8px; border: 1px solid var(--color-border-secondary); border-radius: 6px; font-size: 13px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none; }
.drawer-name-input:focus { border-color: var(--color-primary); }
.drawer-save-btn { padding: 4px 12px; border: none; border-radius: 4px; font-size: 12px; background: var(--color-primary, #6366f1); color: #fff; cursor: pointer; white-space: nowrap; }
.drawer-save-btn:disabled { opacity: 0.5; cursor: default; }
.drawer-save-btn.saved { background: #27ae60; }
.drawer-desc-input { width: 100%; padding: 8px 10px; border: 1px solid var(--color-border-secondary); border-radius: 6px; font-size: 12px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none; resize: vertical; font-family: inherit; line-height: 1.5; min-height: 52px; }
.drawer-desc-input:focus { border-color: var(--color-primary); }
.drawer-error { font-size: 11px; color: #e74c3c; margin-top: 4px; }
.drawer-section-bottom { border-bottom: none; display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.drawer-leave-btn, .drawer-delete-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; text-align: left; }
.drawer-delete-btn { background: none; color: #e74c3c; }
.drawer-delete-btn:hover { background: #fdecea; }
</style>
