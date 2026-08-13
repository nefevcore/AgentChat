// ============================================================
// core/api/endpoints/groups.ts —— 群组 REST 端点
// ============================================================

import { request, jsonPost, jsonPatch, jsonDelete } from '../client';
import type { GroupInfo } from '../../../types';

export function fetchGroups(): Promise<{ groups: GroupInfo[] }> {
  return request('/api/groups');
}

export function createGroup(payload: { name?: string; participants?: string[]; description?: string; group_id?: string; [key: string]: unknown }): Promise<{ group?: { group_id?: string }; success?: boolean; error?: string }> {
  return jsonPost('/api/groups', payload);
}

export function updateGroup(groupId: string, payload: Record<string, unknown>): Promise<{ success?: boolean; error?: string }> {
  return jsonPatch(`/api/groups/${encodeURIComponent(groupId)}`, payload);
}

export function deleteGroup(groupId: string): Promise<{ success?: boolean; error?: string }> {
  return jsonDelete(`/api/groups/${encodeURIComponent(groupId)}`);
}

/** 群组历史（分页：最新 limit 条 + offset 上翻更早）——消息结构宽松，调用方归一化 */
export function fetchGroupHistory(groupId: string, offset = 0, limit = 50): Promise<{ messages?: any[] }> {
  const q = offset > 0 ? `&offset=${offset}` : '';
  return request(`/api/groups/${encodeURIComponent(groupId)}/history?limit=${limit}${q}`);
}
