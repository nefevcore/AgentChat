// ============================================================
// stores/groups.ts —— 群组状态（从 App.vue 抽出）
//
// 职责：
//   · 群组列表 + 活跃群组 + 创建弹窗状态
//   · 群组 CRUD 的 REST 调用
//   · WS 群组事件（created/deleted/join/leave/message）刷新列表
//   · 群组选中与 feed 活跃对话同步（与 direct 互斥）
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { GroupInfo } from '../types';
import { fetchGroups as apiFetchGroups } from '../api/groups';
import { wireRpc } from '../api/wire';
import { chatPresence } from '../api/chat-ops';
import { useFeedStore } from './feed';
import { useAgentStore } from './agents';
import { loadLastContext, saveLastContext, clearLastContextIf } from '../utils/lastContext';

export const useGroupsStore = defineStore('groups', () => {
  const feed = useFeedStore();

  const groups = ref<GroupInfo[]>([]);
  const activeGroupId = ref('');
  const showCreateGroup = ref(false);

  async function fetchGroups() {
    try {
      const data = await apiFetchGroups();
      groups.value = data.groups ?? [];
      // presence 登记（feed 帧路由的群会话键判别）
      chatPresence.knownGroups.clear();
      for (const g of groups.value) chatPresence.knownGroups.add(g.group_id);
    } catch { /* ignore */ }
  }

  /** 选中群组 — 同步清除 Agent 选中，确保互斥；同步 feed 活跃对话 */
  function selectGroup(groupId: string) {
    useAgentStore().activeAgentId = '';
    activeGroupId.value = groupId;
    feed.setActiveGroup(groupId);
    saveLastContext({ kind: 'group', id: groupId });
  }

  function deselectGroup() {
    activeGroupId.value = '';
    feed.clearActiveGroup();
    clearLastContextIf('group');
  }

  function openCreateGroup() { showCreateGroup.value = true; }
  function closeCreateGroup() { showCreateGroup.value = false; }

  function onGroupCreated(groupId: string) {
    fetchGroups().then(() => selectGroup(groupId));
  }

  function onGroupDeleted(groupId: string) {
    if (activeGroupId.value === groupId) {
      activeGroupId.value = '';
      feed.clearActiveGroup();
      clearLastContextIf('group');
    }
    fetchGroups();
  }

  /** 群组消息事件：更新列表活跃时间并重排 */
  function handleGroupMessage(data: any) {
    const idx = groups.value.findIndex(r => r.group_id === data.group_id);
    if (idx >= 0) {
      groups.value[idx] = { ...groups.value[idx], lastActivity: Date.now() };
      groups.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    }
  }

  /** 初始化：订阅 wire 群事件 + 拉取群组 + 恢复上次选中（仅当上次上下文是群组）。
   *  幂等：RunTracking / RunTrackingPanel 在群列表缺失时也会调 init() 补数据——
   *  wire 订阅随 store 单例只挂一次，二次调用只做列表刷新。 */
  let initialized = false;
  function init() {
    if (initialized) {
      void fetchGroups();
      return;
    }
    initialized = true;
    wireRpc.onWireEvent((type, args) => {
      if (type === 'group/created' || type === 'group/deleted'
        || type === 'group/renamed' || type === 'group/description-set'
        || type === 'group/member-added' || type === 'group/member-removed'
        || type === 'group/memory-owner-set') { // 群主变更（他端设置/属主退群自动解除）同步列表
        void fetchGroups();
        return;
      }
      if (type === 'group/message-posted') {
        handleGroupMessage({ group_id: String((args[0] as unknown) ?? '') });
      }
    });
    void fetchGroups().then(() => {
      // 恢复守卫：群组已被删除/不存在 → 放弃恢复（清掉过期记录）
      if (activeGroupId.value && !groups.value.some(g => g.group_id === activeGroupId.value)) {
        deselectGroup();
      }
    });
    const ctx = loadLastContext();
    if (ctx?.kind === 'group') selectGroup(ctx.id);
  }

  return {
    groups, activeGroupId, showCreateGroup,
    fetchGroups, selectGroup, deselectGroup,
    openCreateGroup, closeCreateGroup,
    onGroupCreated, onGroupDeleted,
    init,
  };
});
