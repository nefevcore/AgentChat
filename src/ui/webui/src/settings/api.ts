// ============================================================
// settings/api.ts —— 类型化 API 层（收拢设置模块全部 fetch）
// P2：插件域走 /api/plugins/assembly|catalog|library|session|staging 新契约。
// ============================================================

import type {
  AgentConfigViews,
  PoolData,
  TimerEntry,
  PluginMeta,
  AgentToolInfo,
  AssemblyView,
  AssemblyUpdate,
  PluginCatalog,
  PluginLibrary,
  PluginInfo,
  PluginPermissionsView,
  StagingRecord,
  StagingFileInfo,
  StagingFileContent,
  MarketEntry,
  MarketSearchResult,
} from './types';
import { request, jsonPost, jsonPut, stripEmpty } from '../core/api/client';

export { stripEmpty };
export type { AgentToolInfo };

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

// ── 插件域（P1 新契约；旧扁平端点保留为兼容回退） ──

/** @deprecated 旧扁平插件数组（一个版本周期；新 UI 用 getAssembly） */
export function getAgentPlugins(agentId: string): Promise<{ plugins: PluginMeta[] }> {
  return request(`/api/plugins/${encodeURIComponent(agentId)}`);
}

/** @deprecated 旧全局钩子目录（新 UI 用 getCatalog） */
export function getGlobalPlugins(): Promise<{ plugins: PluginMeta[] }> {
  return request('/api/plugins/global/hooks');
}

/** @deprecated 旧全局工具目录（新 UI 用 getCatalog） */
export function getGlobalTools(): Promise<{ catalog: AgentToolInfo[]; explicit: string[] }> {
  return request('/api/plugins/global/tools');
}

/** ① Agent 装配视图（presets/hooks 顺序表/tools 显式清单 + 全量目录） */
export function getAssembly(agentId: string): Promise<{ assembly: AssemblyView }> {
  return request(`/api/plugins/assembly/${encodeURIComponent(agentId)}`);
}

/** ① 保存 Agent 装配视图（服务端校验 + 原子写盘 + 热重载 + WS 广播） */
export function saveAssembly(
  agentId: string,
  patch: AssemblyUpdate,
): Promise<{ success: true; assembly: AssemblyView; migrated?: boolean }> {
  return jsonPut(`/api/plugins/assembly/${encodeURIComponent(agentId)}`, patch);
}

/** ② 插件/钩子/工具全量目录（单真相源） */
export function getCatalog(): Promise<PluginCatalog> {
  return request('/api/plugins/catalog');
}

/** ③ 插件库：已安装 + 待审暂存 */
export function getLibrary(): Promise<PluginLibrary> {
  return request('/api/plugins/library');
}

/** ③ 发布第一阶段：暂存待审 */
export function stagePlugin(dir: string, owner: string): Promise<{ staging: StagingRecord }> {
  return jsonPost('/api/plugins/library/stage', { dir, owner });
}

/** ③ 人审通过后安装（grants 为 UI 勾选结果） */
export function approvePlugin(id: string, grants: string[]): Promise<{ installed: PluginInfo }> {
  return jsonPost('/api/plugins/library/approve', { id, grants });
}

/** ③ 拒绝暂存 */
export function rejectPlugin(id: string): Promise<{ success: true }> {
  return jsonPost('/api/plugins/library/reject', { id });
}

/** ③ 卸载已安装插件（目录移 .backup） */
export function uninstallPlugin(name: string): Promise<{ success: true; backupDir?: string }> {
  return jsonPost(`/api/plugins/library/${encodeURIComponent(name)}/uninstall`);
}

// ── ⑤ 插件市场（/api/plugins/market/*；search 显式触发，构造零网络） ──

/** 市场搜索（topic:agentchat 聚合；源失败返回缓存并带 stale 标记） */
export function searchMarket(query?: string): Promise<MarketSearchResult> {
  const qs = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  return request(`/api/plugins/market/search${qs}`);
}

/** 本地缓存索引（离线可看清单，零网络） */
export function getCachedMarket(): Promise<{ entries: MarketEntry[] }> {
  return request('/api/plugins/market/cached');
}

/** 市场暂存（进 WebUI 待审人审队列；返回暂存记录） */
export function stageMarket(spec: string, owner?: string): Promise<{ staging: StagingRecord }> {
  return jsonPost('/api/plugins/market/stage', { spec, owner });
}

/** 市场一步安装；缺高危 grants 时 400（前端回落 stage + 人审流） */
export function installMarket(spec: string, grants?: string[]): Promise<{ installed: { name: string; version: string; hash: string } }> {
  return jsonPost('/api/plugins/market/install', { spec, grants });
}

/** ④ 会话级插件列表（开发态） */
export function getSessionPlugins(): Promise<{ plugins: PluginInfo[] }> {
  return request('/api/plugins/session');
}

/** ④ 开发目录 → 会话级加载（重启即失；启用需在 Agent 面板勾选 preset） */
export function registerSessionPlugin(
  dir: string,
  owner?: string,
  grants?: string[],
): Promise<{ status: 'loaded' | 'replaced'; plugin: PluginInfo }> {
  return jsonPost('/api/plugins/session/register', { dir, owner, grants, watch: true });
}

/** ④ 会话级插件重载 */
export function reloadSessionPlugin(name: string): Promise<{ status: 'loaded' | 'replaced' }> {
  return jsonPost(`/api/plugins/session/${encodeURIComponent(name)}/reload`);
}

/** ④ 会话级插件卸载 */
export function unloadSessionPlugin(name: string): Promise<{ success: true }> {
  return jsonPost(`/api/plugins/session/${encodeURIComponent(name)}/unload`);
}

/** ⑤ 权限词汇表（徽章 / grants 勾选数据源） */
export function getPermissions(): Promise<PluginPermissionsView> {
  return request('/api/plugins/permissions');
}

/** ⑥ 暂存目录文件树（人审） */
export function getStagingTree(id: string): Promise<{ files: StagingFileInfo[] }> {
  return request(`/api/plugins/staging/${encodeURIComponent(id)}/tree`);
}

/** ⑥ 暂存文件内容（人审只读） */
export function getStagingFile(id: string, path: string): Promise<StagingFileContent> {
  return request(`/api/plugins/staging/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
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

/** @deprecated 旧工具清单端点（新 UI 从 getAssembly 的 tools 视图读取） */
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
