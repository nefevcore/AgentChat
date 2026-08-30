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
import { WS_EVENT } from '../core/events/contract';
import { registerEventHandler } from '../core/registry/eventHandlers';
import { fetchGroups as apiFetchGroups } from '../core/api/endpoints/groups';
import { useFeedStore } from './feed';
import { useWebSocketStore } from './websocket';
import { useAgentStore } from './agents';
import { loadLastContext, saveLastContext, clearLastContextIf } from '../utils/lastContext';

export const useGroupsStore = defineStore('groups', () => {
  const feed = useFeedStore();
  const ws = useWebSocketStore();

  const groups = ref<GroupInfo[]>([]);
  const activeGroupId = ref('');
  const showCreateGroup = ref(false);

  async function fetchGroups() {
    try {
      const data = await apiFetchGroups();
      groups.value = data.groups ?? [];
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

  /** 初始化：注册群组事件 + 拉取群组 + 恢复上次选中（仅当上次上下文是群组）。
   *  幂等：RunTracking / RunTrackingPanel 在群列表缺失时也会调 init() 补数据——
   *  重复注册事件处理器会造成每个群事件触发 N 次 fetchGroups（处理器累积），
   *  且重复执行"恢复上次选中"会劫持用户当前上下文。二次调用只做列表刷新。 */
  let initialized = false;
  function init() {
    if (initialized) {
      void fetchGroups();
      return;
    }
    initialized = true;
    for (const t of [
      WS_EVENT.groupCreated, WS_EVENT.groupDeleted,
      WS_EVENT.groupJoin, WS_EVENT.groupLeave,
    ]) {
      registerEventHandler(t, () => fetchGroups());
    }
    registerEventHandler(WS_EVENT.groupMessage, handleGroupMessage);
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
