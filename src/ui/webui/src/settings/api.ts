// ============================================================
// settings/api.ts —— 类型化 API 层（收拢设置模块全部 fetch）
// ============================================================

import type { AgentConfigViews, PoolData, TimerEntry, PluginMeta } from './types';
import { request, jsonPost, stripEmpty } from '../core/api/client';

export { stripEmpty };

// ── 全局配置 ──

export function getGlobalConfig(): Promise<{ config: Record<string, any> }> {
  return request('/api/config');
}

export function saveGlobalConfig(config: Record<string, any>): Promise<{ success?: boolean; error?: string }> {
  return jsonPost('/api/config', { config });
}

export function getPools(): Promise<PoolData> {
  return request('/api/config/pools');
}

// ── Schema ──

export function getLlmSchemas(): Promise<Record<string, any[]>> {
  return request('/api/plugins/llm-schemas');
}

export function getSearchSchemas(): Promise<Record<string, any[]>> {
  return request('/api/plugins/search-schemas');
}

export function getNamespaceSchemas(): Promise<{ namespaces: Record<string, any[]>; extensions?: any; tools?: any }> {
  return request('/api/plugins/schemas');
}

// ── Agent 配置 ──

/** 创建新 Agent（id 留空则自动生成 UUID） */
export function createAgent(payload: { id?: string; name?: string; provider?: string; llm?: Record<string, any> }): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  return jsonPost('/api/agents', payload);
}

export function deleteAgent(agentId: string): Promise<{ success?: boolean; error?: string }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

export function getAgentConfig(agentId: string): Promise<AgentConfigViews> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/config`);
}

export function saveAgentConfig(
  agentId: string,
  payload: { config: Record<string, any>; sysContent?: string; agentContent?: string },
): Promise<{ success?: boolean; error?: string }> {
  return jsonPost(`/api/agents/${encodeURIComponent(agentId)}/config`, payload);
}

export function getAgentTimers(agentId: string): Promise<{ entries: TimerEntry[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/timer`);
}

export function saveAgentTimers(agentId: string, entries: TimerEntry[]): Promise<{ entries: TimerEntry[] }> {
  return jsonPost(`/api/agents/${encodeURIComponent(agentId)}/timer`, { entries });
}

export function getAgentPlugins(agentId: string): Promise<{ plugins: PluginMeta[] }> {
  return request(`/api/plugins/${encodeURIComponent(agentId)}`);
}

/** 全局钩子目录（无开关，仅目录 + 默认配置入口） */
export function getGlobalPlugins(): Promise<{ plugins: PluginMeta[] }> {
  return request('/api/plugins/global/hooks');
}

/** 全局工具目录（全局显式声明 + 命名空间配置入口） */
export function getGlobalTools(): Promise<{ catalog: AgentToolInfo[]; explicit: string[] }> {
  return request('/api/plugins/global/tools');
}

/** 工具清单：全部目录 + 实际启用（自动注入/显式声明） */
export interface AgentToolInfo {
  name: string;
  label?: string;
  description?: string;
  requires?: string[];
  ns?: string;
}
export function getAgentTools(agentId: string): Promise<{ catalog: AgentToolInfo[]; enabled: string[]; explicit: string[] }> {
  return request(`/api/plugins/tools/${encodeURIComponent(agentId)}`);
}

// ── 杂项 ──

export function browseFile(accept?: string, title?: string): Promise<{ success: boolean; path?: string }> {
  return jsonPost('/api/browse/file', { accept, title });
}

export function uploadAvatar(agentId: string, file: File): Promise<{ success?: boolean; error?: string }> {
  const form = new FormData();
  form.append('file', file);
  return request(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'POST', body: form });
}

export function deleteAvatar(agentId: string): Promise<{ success?: boolean; deleted?: boolean; error?: string }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'DELETE' });
}
