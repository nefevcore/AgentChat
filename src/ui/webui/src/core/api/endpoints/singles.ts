// ============================================================
// Singles API —— /api/singles（独立会话，P3）
// ============================================================

import { request, jsonPost, jsonDelete, jsonPatch } from '../client';

/** 独立会话元数据（与 @agentchat/protocol SingleSessionInfo 对齐） */
export interface SingleSession {
  id: string;
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
  /** 所属用户工作区（workspaceId 引用；缺省/空 = 未分组） */
  workspaceId?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

export function fetchSingles(): Promise<{ singles: SingleSession[] }> {
  return request('/api/singles');
}

export function createSingle(payload: {
  /** 空/缺省 = 空会话（P4 快速创建，输入栏再选） */
  agentId?: string;
  model?: string | Record<string, unknown>;
  title?: string;
  /** 挂入用户工作区（缺省 = 未分组） */
  workspaceId?: string;
  /** true = 已存在空会话时复用（不重复建空白条目） */
  reuse?: boolean;
}): Promise<{ session: SingleSession; reused?: boolean }> {
  return jsonPost(`/api/singles${payload.reuse ? '?reuse=1' : ''}`, payload);
}

/** 更新会话设置（agentId ''=清空待选（已有消息时 409 禁改）；model=null 清除覆盖回落 Agent 原配置；workspaceId ''=移入未分组） */
export function updateSingle(id: string, payload: {
  agentId?: string;
  model?: string | Record<string, unknown> | null;
  title?: string;
  workspaceId?: string;
}): Promise<{ session: SingleSession }> {
  return jsonPatch(`/api/singles/${id}`, payload);
}

/** 归档（软删，消息保留） */
export function archiveSingle(id: string): Promise<{ session: SingleSession }> {
  return jsonDelete(`/api/singles/${id}`);
}

/** 删除（硬删：元数据 + 消息记录，不可恢复） */
export function deleteSingle(id: string): Promise<{ deleted: boolean }> {
  return jsonDelete(`/api/singles/${id}?purge=1`);
}
