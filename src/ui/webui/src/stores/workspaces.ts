// ============================================================
// Workspaces Store —— 用户工作区（会话树分组的文件夹白名单）
//
// 用户工作区 = 用户登记的本机文件夹：会话列表树的根节点；
// 挂在其下的独立会话运行时把该文件夹并入沙箱路径白名单
// （后端 extraAllowedPaths 链路）。
// ============================================================

import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  fetchWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace,
  type Workspace,
} from '../core/api/endpoints/workspaces';
import { logger } from '../utils/logger';

export const useWorkspacesStore = defineStore('workspaces', () => {
  const workspaces = ref<Workspace[]>([]);
  const loaded = ref(false);

  async function refresh(): Promise<void> {
    try {
      const d = await fetchWorkspaces();
      workspaces.value = d.workspaces ?? [];
      loaded.value = true;
    } catch (err: any) {
      logger.warn('[WorkspacesStore] 拉取用户工作区失败:', err?.message ?? String(err));
    }
  }

  async function create(payload: { path: string; name?: string }): Promise<Workspace> {
    const d = await createWorkspace(payload);
    await refresh();
    return d.workspace;
  }

  async function rename(id: string, name: string): Promise<void> {
    await updateWorkspace(id, { name });
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    await deleteWorkspace(id);
    await refresh();
  }

  return { workspaces, loaded, refresh, create, rename, remove };
});
