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
  createAgent as pkgCreateAgent,
  fetchLlmProviders as pkgFetchLlmProviders,
  type LlmProviderStat,
} from 'ac-client-ui-agents/client';
import {
  fetchSessionTokens as pkgFetchSessionTokens,
  deleteAgent as pkgDeleteAgent,
  fetchPools as pkgFetchPools,
  fetchAgentModels as pkgFetchAgentModels,
  poolModelEntries as pkgPoolModelEntries,
  visibleModelNames as pkgVisibleModelNames,
  type SessionTokens,
} from 'ac-client-ui-conversation/client/rosterApi.ts';
import { uploadAvatar as pkgUploadAvatar, deleteAvatar as pkgDeleteAvatar } from 'ac-client-ui-agents/client';

export type { AgentInfo, AgentPresetInfo, LlmProviderStat } from 'ac-client-ui-agents/client';
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

/** 创建 Agent（src 形状 → preview AgentConfig 白名单）——owning =
 *  ac-client-ui-agents/client（M27.2-2 sidebar 面板壳随件迁；薄包装补
 *  wireRpc 缺省维持旧签名） */
export function createAgent(
  payload: { id?: string; name?: string; provider?: string; llm?: Record<string, unknown>; tools?: unknown },
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  return pkgCreateAgent(payload, rpc);
}

export async function deleteAgent(agentId: string, rpc: Rpc = wireRpc): Promise<{ success?: boolean; error?: string }> {
  return pkgDeleteAgent(agentId, rpc);
}

// ---- 模型 / 池 ----

/** Provider 注册面快照（llm/providers）——owning =
 *  ac-client-ui-agents/client（薄包装补 wireRpc 缺省维持旧签名） */
export function fetchLlmProviders(rpc: Rpc = wireRpc): Promise<{ providers: string[]; stats: LlmProviderStat[] }> {
  return pkgFetchLlmProviders(rpc);
}

/** 模型能力元数据条目（与后端 PoolModelEntry 同形）
 *  —— PoolModelMeta/poolModelEntries/visibleModelNames owning =
 *  ac-client-ui-conversation/client/rosterApi.ts（顶部 re-export 维持旧路径） */

/** 模型发现（llm/models 真 /models 代理）——owning =
 *  ac-client-ui-conversation/client/rosterApi.ts（M27.2-2 settings 件
 *  出包随件迁；薄包装补 wireRpc 缺省维持旧签名） */
export function fetchAgentModels(
  name: string,
  refresh = false,
  rpc: Rpc = wireRpc,
): Promise<{ models: string[] }> {
  return pkgFetchAgentModels(name, refresh, rpc);
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

// ---- 头像（preview 真实 HTTP multipart 面——owning =
//      ac-client-ui-agents/client；re-export 维持旧路径） ----

export { pkgUploadAvatar as uploadAvatar, pkgDeleteAvatar as deleteAvatar };

// ---- 预设 Agent 目录（独立会话选用 UI / 空会话默认路由目标；ac-agent-presets 物化）----
// AgentPresetInfo / fetchAgentPresets 已随行走迁 ac-client-ui-agents/client（顶部包装）
