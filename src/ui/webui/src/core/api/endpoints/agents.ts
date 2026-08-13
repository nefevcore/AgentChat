// ============================================================
// core/api/endpoints/agents.ts —— Agent / 池 / 模型 / 头像 端点
// ============================================================

import { request, jsonPost, jsonDelete } from '../client';
import type { AgentInfo } from '../../../types';

export function fetchAgents(): Promise<{ agents: AgentInfo[] }> {
  return request('/api/agents');
}

export function createAgent(payload: { id?: string; name?: string; provider?: string; llm?: Record<string, unknown> }): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  return jsonPost('/api/agents', payload);
}

export function deleteAgent(agentId: string): Promise<{ success?: boolean; error?: string }> {
  return jsonDelete(`/api/agents/${encodeURIComponent(agentId)}`);
}

/** 模型列表（/api/agents/models?<params>） */
export function fetchAgentModels(params: string): Promise<{ models?: string[] }> {
  return request(`/api/agents/models?${params}`);
}

export function fetchPools(): Promise<{ llmProviders?: Record<string, Record<string, unknown>>; searchProviders?: Record<string, Record<string, unknown>> }> {
  return request('/api/config/pools');
}

export function uploadAvatar(agentId: string, file: File): Promise<{ success?: boolean; error?: string }> {
  const form = new FormData();
  form.append('file', file);
  return request(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'POST', body: form });
}

export function deleteAvatar(agentId: string): Promise<{ success?: boolean; deleted?: boolean; error?: string }> {
  return jsonDelete(`/api/agents/${encodeURIComponent(agentId)}/avatar`);
}

/** 会话 Token 用量基线 */
export interface SessionTokens {
  tokenCount?: number;
  messageCount?: number;
  maxContextTokens?: number;
  usagePercent?: number;
  avgTokensPerMsg?: number;
  estimatedMsgsRemaining?: number;
  status?: 'low' | 'moderate' | 'high' | 'critical';
}

export function fetchSessionTokens(agentId: string): Promise<SessionTokens> {
  return request(`/api/sessions/${encodeURIComponent(agentId)}/tokens`);
}
