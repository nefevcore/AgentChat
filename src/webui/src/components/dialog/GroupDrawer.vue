<script setup lang="ts">
// ============================================================
// components/dialog/GroupDrawer.vue —— 群聊信息抽屉（成员/名称/简介/群主/删除）
// 从 DialogView 拆分，降低主视图体积。
// ============================================================

import { ref, computed, watch } from 'vue';
import type { GroupInfo } from '../../types';
import { VIEWER_ID } from '../../constants';
import { updateGroup, setGroupMemoryOwner } from '../../api/groups';
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
// 群主（记忆属主）选择——'' = 未设置（解除）
const ownerSelection = ref('');
const ownerError = ref('');
const ownerSaving = ref(false);

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
    isOwner: id === props.group.memory_owner,
  }))
);

/** 群主候选 = 群成员中的 Agent（viewer 不是注册 Agent，不能任属主） */
const ownerCandidates = computed(() =>
  (props.group.participants ?? [])
    .filter(p => p !== VIEWER_ID.value)
    .map(id => ({ id, name: getMemberName(id) }))
);

/** 名称/简介任一变更即脏（仅改简介也可保存——曾因禁用条件只看名称，
 *  简介改动后保存钮恒禁用，改了也存不进） */
const infoDirty = computed(() =>
  editingName.value.trim() !== props.group.name
  || editingDescription.value !== (props.group.description ?? ''));

/** 打开（或切换群组）时初始化编辑字段——此前初始化函数从未被调用，
 *  名称输入框永远为空、保存按钮恒禁用 */
watch(() => [props.visible, props.group.group_id] as const, ([v]) => {
  if (!v) return;
  editingName.value = props.group.name ?? '';
  editingDescription.value = props.group.description ?? '';
  memberSearchQuery.value = '';
  renameError.value = '';
  ownerSelection.value = props.group.memory_owner ?? '';
  ownerError.value = '';
}, { immediate: true });

// 外部变更（他端设置/属主退群自动解除 → memory-owner-set 事件 → fetchGroups
// 换新对象）：跟写选择框；保存进行中不覆盖（本地正在等 RPC 回程）
watch(() => props.group.memory_owner, (v) => {
  if (ownerSaving.value) return;
  ownerSelection.value = v ?? '';
  ownerError.value = '';
});

/** 群主设定/解除——即时生效（无独立保存钮），失败回退选择框 */
async function applyOwnerChange() {
  const next = ownerSelection.value;
  const current = props.group.memory_owner ?? '';
  if (next === current) return;
  ownerSaving.value = true;
  ownerError.value = '';
  try {
    await setGroupMemoryOwner(props.group.group_id, next);
    // 本地回写（即时反馈）+ 列表刷新保持一致（与 saveGroupInfo 同款）
    if (next) props.group.memory_owner = next;
    else delete props.group.memory_owner;
    void groupsStore.fetchGroups();
  } catch (err: any) {
    ownerError.value = `设置失败: ${err.message}`;
    ownerSelection.value = current; // 回退到现值
  } finally {
    ownerSaving.value = false;
  }
}

async function saveGroupInfo() {
  if (saving.value || !editingName.value.trim()) return;
  // 只发变更字段（仅改简介不再附带 rename——群名未变不发 group/renamed）
  const body: Record<string, string> = {};
  if (editingName.value.trim() !== props.group.name) body.name = editingName.value.trim();
  if (editingDescription.value !== (props.group.description ?? '')) body.description = editingDescription.value;
  if (!body.name && !body.description) return;
  saving.value = true;
  renameError.value = '';
  renameSaved.value = false;
  try {
    await updateGroup(props.group.group_id, body);
    // 本地回写（名称此前不回写，标题/列表残留旧名）+ 刷新列表保持一致；
    // 简介清空 = 删键（与后端"空 → undefined 清空"对齐）
    props.group.name = editingName.value.trim();
    if (editingDescription.value) props.group.description = editingDescription.value;
    else delete props.group.description;
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
            <span v-else-if="m.isOwner" class="member-owner" title="群主（记忆属主）">群主</span>
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
        <button class="drawer-save-btn" :class="{ saved: renameSaved }" @click="saveGroupInfo" :disabled="saving || !editingName.trim() || !infoDirty">{{ renameSaved ? '已保存' : '保存' }}</button>
      </div>
      <div v-if="renameError" class="drawer-error">{{ renameError }}</div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">群聊简介</div>
      <textarea v-model="editingDescription" class="drawer-desc-input" placeholder="添加群聊简介..." rows="3"></textarea>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-title">群主</div>
      <select v-model="ownerSelection" class="drawer-owner-select" :disabled="ownerSaving" @change="applyOwnerChange">
        <option value="">未设置（成员各自维护记忆）</option>
        <option v-for="c in ownerCandidates" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <p class="drawer-owner-hint">群主即记忆属主：统一管理群记忆与归档概要，全体成员共享注入；须为群成员，退群自动解除</p>
      <div v-if="ownerError" class="drawer-error">{{ ownerError }}</div>
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
.member-owner { position: absolute; left: -5px; top: -3px; font-size: 9px; font-weight: 600; color: #fff; line-height: 14px; padding: 0 4px; border-radius: 8px; background: #f59e0b; border: 1.5px solid var(--color-bg-surface); }
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
.drawer-owner-select { width: 100%; padding: 6px 8px; border: 1px solid var(--color-border-secondary); border-radius: 6px; font-size: 12px; background: var(--color-bg-page); color: var(--color-text-primary); outline: none; cursor: pointer; }
.drawer-owner-select:focus { border-color: var(--color-primary); }
.drawer-owner-select:disabled { opacity: 0.5; cursor: default; }
.drawer-owner-hint { font-size: 11px; color: var(--color-text-tertiary); margin: 6px 0 0; line-height: 1.5; }
.drawer-section-bottom { border-bottom: none; display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.drawer-leave-btn, .drawer-delete-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; text-align: left; }
.drawer-delete-btn { background: none; color: #e74c3c; }
.drawer-delete-btn:hover { background: #fdecea; }
</style>
