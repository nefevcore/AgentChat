// ============================================================
// Singles API —— /api/singles（独立会话，P3）
// ============================================================

import { request, jsonPost, jsonDelete } from '../client';

/** 独立会话元数据（与 @agentchat/protocol SingleSessionInfo 对齐） */
export interface SingleSession {
  id: string;
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastActivity?: string;
}

export function fetchSingles(): Promise<{ singles: SingleSession[] }> {
  return request('/api/singles');
}

export function createSingle(payload: {
  agentId: string;
  model?: string | Record<string, unknown>;
  title?: string;
}): Promise<{ session: SingleSession }> {
  return jsonPost('/api/singles', payload);
}

export function archiveSingle(id: string): Promise<{ session: SingleSession }> {
  return jsonDelete(`/api/singles/${id}`);
}
