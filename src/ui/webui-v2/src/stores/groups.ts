// ============================================================
// stores/groups.ts —— 群组列表 + WS 事件（纯数据）
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { GroupInfo } from '@/domain/types';
import { groupApi } from '@/services/api';

const LAST_GROUP_KEY = 'agentchat.v2.lastGroup';

export const useGroupStore = defineStore('groups', () => {
  const groups = ref<GroupInfo[]>([]);

  async function fetchGroups(): Promise<void> {
    try {
      const data = await groupApi.list();
      groups.value = data.groups ?? [];
    } catch { /* ignore */ }
  }

  function bumpActivity(groupId: string): void {
    const idx = groups.value.findIndex(r => r.group_id === groupId);
    if (idx >= 0) {
      groups.value[idx] = { ...groups.value[idx], lastActivity: Date.now() };
      groups.value.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    }
  }

  function persistLastGroup(groupId: string): void {
    try { localStorage.setItem(LAST_GROUP_KEY, groupId); } catch { /* ignore */ }
  }
  function clearLastGroup(): void {
    try { localStorage.removeItem(LAST_GROUP_KEY); } catch { /* ignore */ }
  }
  function restoreLastGroup(): string | null {
    try { return localStorage.getItem(LAST_GROUP_KEY); } catch { return null; }
  }

  return {
    groups,
    fetchGroups, bumpActivity,
    persistLastGroup, clearLastGroup, restoreLastGroup,
  };
});
