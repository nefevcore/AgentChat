// ============================================================
// api/roster.ts —— Agent 名册 Port B
//
// agents 写侧/模型/池/会话 Token 直连（rpc 词汇）；头像三端点
// 是 preview 真实 HTTP multipart 面，直连 fetch。
// 名册读面（toAgentList/fetchAgents/fetchAgentPresets + AgentInfo/
// AgentPresetInfo）已随行走迁 ac-client-ui-agents/client（M27 S3-1b——本模块
// re-export 维持旧路径与旧签名[缺省 wireRpc]）。
// ============================================================

import { wireRpc } from './wire.ts';
import {
  toAgentList,
  fetchAgents as rowFetchAgents,
  fetchAgentPresets as rowFetchAgentPresets,
} from 'ac-client-ui-agents/client';
import {
  fetchSessionTokens as pkgFetchSessionTokens,
  deleteAgent as pkgDeleteAgent,
  fetchPools as pkgFetchPools,
  poolModelEntries as pkgPoolModelEntries,
  visibleModelNames as pkgVisibleModelNames,
  type SessionTokens,
} from 'ac-client-ui-conversation/client/rosterApi.ts';

export type { AgentInfo, AgentPresetInfo } from 'ac-client-ui-agents/client';
export type { SessionTokens, PoolModelMeta } from 'ac-client-ui-conversation/client/rosterApi.ts';
export { poolModelEntries, visibleModelNames } from 'ac-client-ui-conversation/client/rosterApi.ts';
export { toAgentList };

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** preview AgentConfig 白名单形状（fetchSessionTokens 契约词汇；名册合成版随行走迁 ac-client-ui-agents/client） */
export interface PAgentConfig {
  id: string;
  model?: string;
  provider?: string;
  virtual?: boolean;
  name?: string;
  description?: string;
  tags?: string[];
  llmParams?: Record<string, unknown>;
  tools?: unknown;
  settings?: Record<string, unknown>;
  maxSteps?: number;
}

// ---- 名册（ac-client-ui-agents/client 薄包装：补 wireRpc 缺省） ----

export function fetchAgents(rpc: Rpc = wireRpc) {
  return rowFetchAgents(rpc);
}

export function fetchAgentPresets(rpc: Rpc = wireRpc) {
  return rowFetchAgentPresets(rpc);
}

// ---- 写侧 ----

/** 创建 Agent（src 形状 → preview AgentConfig 白名单） */
export async function createAgent(
  payload: { id?: string; name?: string; provider?: string; llm?: Record<string, unknown>; tools?: unknown },
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  const config: Record<string, unknown> = {};
  if (payload.id) config.id = payload.id;
  if (payload.name) config.name = payload.name;
  if (payload.provider) config.provider = payload.provider;
  const model = (payload.llm as Record<string, unknown> | undefined)?.model;
  if (typeof model === 'string' && model) config.model = model;
  if (payload.tools !== undefined) config.tools = payload.tools;
  const r = await rpc.call<{ config?: { id?: string } }>('agents/create', { config });
  return { success: true, agentId: r.config?.id ?? payload.id };
}

export async function deleteAgent(agentId: string, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  return pkgDeleteAgent(agentId, rpc);
}

// ---- 模型 / 池 ----

/** Provider 注册面快照（llm/providers：名称/模型缓存/连接锚点——AgentPane
 *  provider 选择器与 ChatInput 模型菜单数据源） */
export interface LlmProviderStat {
  name: string;
  models: string[];
  instantiated?: boolean;
  description?: string;
  baseUrl?: string;
  /** 模型能力元数据（探测/手配：vision/hidden——徽章与下拉过滤消费） */
  modelMeta?: Record<string, { vision?: boolean; hidden?: boolean }>;
}

export async function fetchLlmProviders(rpc: Rpc = wireRpc): Promise<{ providers: string[]; stats: LlmProviderStat[] }> {
  return rpc.call<{ providers?: string[]; stats?: LlmProviderStat[] }>('llm/providers').then((r) => ({
    providers: r.providers ?? [],
    stats: r.stats ?? [],
  }));
}

/** 模型能力元数据条目（与后端 PoolModelEntry 同形）
 *  —— PoolModelMeta/poolModelEntries/visibleModelNames owning =
 *  ac-client-ui-conversation/client/rosterApi.ts（顶部 re-export 维持旧路径） */

/** 模型发现（llm/models 真 /models 代理：后端附加 pool:<name> 凭据；
 *  refresh = 强制拉取并回写发现缓存——下拉随刷新联动） */
export async function fetchAgentModels(name: string, refresh = false, rpc: Rpc = wireRpc): Promise<{ models: string[] }> {
  const r = await rpc.call<{ name?: string; models?: string[] }>('llm/models', { name, ...(refresh ? { refresh: true } : {}) });
  return { models: r.models ?? [] };
}

/** Provider 池（config 白名单域合成；AgentList 建档下拉 / ChatInput 模型覆盖）
 *  —— owning = ac-client-ui-conversation/client/rosterApi.ts（薄包装补 wireRpc 缺省） */
export function fetchPools(rpc: Rpc = wireRpc) {
  return pkgFetchPools(rpc);
}

// ---- 会话 Token 仪表 ----
// SessionTokens 形状 + fetchSessionTokens 归一面 owning =
// ac-client-ui-conversation/client/rosterApi.ts（M27.2-2 视图半边
// 随件迁——薄包装补 wireRpc 缺省维持旧签名）

/** 会话 Token 用量（session/tokens 全量透传；直答会话键 =
 *  pairKey(viewer, agentId)；single 传 opts.conversationId = sid +
 *  opts.agentId = 承载 Agent——同 session/archive 口径） */
export function fetchSessionTokens(
  agentId: string,
  rpc: Rpc = wireRpc,
  opts?: { conversationId?: string; agentId?: string },
): Promise<SessionTokens> {
  return pkgFetchSessionTokens(agentId, rpc, opts);
}

// ---- 头像（preview 真实 HTTP multipart 面，浏览器直连） ----

export function uploadAvatar(agentId: string, file: File): Promise<{ success?: boolean; error?: string }> {
  const form = new FormData();
  form.append('file', file);
  return fetch(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'POST', body: form }).then(async (resp) => {
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? `HTTP ${resp.status}`);
    return resp.json() as Promise<{ success?: boolean; error?: string }>;
  });
}

export async function deleteAvatar(agentId: string): Promise<{ success?: boolean; deleted?: boolean; error?: string }> {
  const resp = await fetch(`/api/agents/${encodeURIComponent(agentId)}/avatar`, { method: 'DELETE' });
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? `HTTP ${resp.status}`);
  return resp.json() as Promise<{ success?: boolean; deleted?: boolean; error?: string }>;
}

// ---- 预设 Agent 目录（独立会话选用 UI / 空会话默认路由目标；ac-agent-presets 物化）----
// AgentPresetInfo / fetchAgentPresets 已随行走迁 ac-client-ui-agents/client（顶部包装）
