// ============================================================
// core/api/endpoints/workspaces.ts —— /api/workspaces（用户工作区）
//
// 用户工作区 = 用户登记的本机文件夹（白名单区域）：会话列表树的
// 根节点分组；挂在其下的会话运行时把该文件夹并入沙箱路径白名单。
// 与数据目录（workspace/default）无关。
// ============================================================

import { request, jsonPost, jsonPatch, jsonDelete } from '../client';

/** 用户工作区元数据（与 @agentchat/protocol WorkspaceInfo 对齐） */
export interface Workspace {
  id: string;
  name: string;
  /** 文件夹绝对路径（会话沙箱白名单根） */
  path: string;
  createdAt: string;
  updatedAt: string;
}

export function fetchWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  return request('/api/workspaces');
}

export function createWorkspace(payload: { path: string; name?: string }): Promise<{ workspace: Workspace }> {
  return jsonPost('/api/workspaces', payload);
}

/** 更新（改名 / 换文件夹；至少一个字段） */
export function updateWorkspace(id: string, payload: { name?: string; path?: string }): Promise<{ workspace: Workspace }> {
  return jsonPatch(`/api/workspaces/${id}`, payload);
}

/** 删除登记（会话保留 → 未分组） */
export function deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
  return jsonDelete(`/api/workspaces/${id}`);
}
