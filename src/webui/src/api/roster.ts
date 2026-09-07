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
import { VIEWER_ID } from '../constants';
import {
  toAgentList,
  fetchAgents as rowFetchAgents,
  fetchAgentPresets as rowFetchAgentPresets,
} from 'ac-client-ui-agents/client';

export type { AgentInfo, AgentPresetInfo } from 'ac-client-ui-agents/client';
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
  await rpc.call('agents/delete', { agentId });
  return { success: true };
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

/** 模型能力元数据条目（与后端 PoolModelEntry 同形） */
export interface PoolModelMeta {
  model: string;
  vision?: true;
  hidden?: true;
}

/**
 * 池条目 models 宽容归一（读侧唯一解析点）：裸名 string / 对象
 * {model, vision?, hidden?} 双形态 → 统一对象形态。下拉过滤、PoolManager
 * 徽章/隐藏开关、保存写回共用——config 里两种写法都合法。
 */
export function poolModelEntries(raw: unknown): PoolModelMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolModelMeta[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    let e: PoolModelMeta | undefined;
    if (typeof m === 'string' && m) e = { model: m };
    else if (m !== null && typeof m === 'object' && typeof (m as { model?: unknown }).model === 'string' && (m as { model: string }).model) {
      const o = m as { model: string; vision?: unknown; hidden?: unknown };
      e = { model: o.model, ...(o.vision === true ? { vision: true } : {}), ...(o.hidden === true ? { hidden: true } : {}) };
    }
    if (!e || seen.has(e.model)) continue;
    seen.add(e.model);
    out.push(e);
  }
  return out;
}

/** 下拉可见模型名（hidden 过滤——纯 UI 呈现语义，路由不受影响） */
export function visibleModelNames(raw: unknown): string[] {
  return poolModelEntries(raw).filter((e) => e.hidden !== true).map((e) => e.model);
}

/** 模型发现（llm/models 真 /models 代理：后端附加 pool:<name> 凭据；
 *  refresh = 强制拉取并回写发现缓存——下拉随刷新联动） */
export async function fetchAgentModels(name: string, refresh = false, rpc: Rpc = wireRpc): Promise<{ models: string[] }> {
  const r = await rpc.call<{ name?: string; models?: string[] }>('llm/models', { name, ...(refresh ? { refresh: true } : {}) });
  return { models: r.models ?? [] };
}

/** Provider 池（config 白名单域合成；AgentList 建档下拉 / ChatInput 模型覆盖） */
export async function fetchPools(rpc: Rpc = wireRpc): Promise<{ llmProviders: Record<string, Record<string, unknown>>; searchProviders: Record<string, Record<string, unknown>> }> {
  const r = await rpc.call<{ config?: Record<string, unknown> }>('config/get');
  const cfg = r.config ?? {};
  return {
    llmProviders: (cfg.llmProviders ?? cfg.llm ?? {}) as Record<string, Record<string, unknown>>,
    searchProviders: (cfg.searchProviders ?? {}) as Record<string, Record<string, unknown>>,
  };
}

// ---- 会话 Token 仪表 ----

export interface SessionTokens {
  tokenCount?: number;
  messageCount?: number;
  maxContextTokens?: number;
  usagePercent?: number;
  avgTokensPerMsg?: number;
  estimatedMsgsRemaining?: number;
  status?: 'low' | 'moderate' | 'high' | 'critical';
  /** 缓存命中面（provider prompt cache 详情；展示 enrich，不驱动仪表值） */
  cache?: {
    /** 最近一次 run 命中/未命中（多步 run 为各步合计） */
    lastHit?: number;
    lastMiss?: number;
    /** 会话累计命中/未命中 */
    hit?: number;
    miss?: number;
    /** 末次 run 实际输入（计费口径对照——含系统提示/工具等固定开销） */
    lastRunPrompt?: number;
  };
}

/** 会话 Token 用量（session/tokens 全量透传：tokenCount = contextTokens，
 *  当前上下文实时估算——概要 + 回放口径 records（与归档阈值同源；归档
 *  compact 后即时回落，不依赖末次 run 实测快照）。usagePercent /
 *  avgTokensPerMsg / estimatedMsgsRemaining 由后端按归档预算
 *  maxContextTokens 派生——缺省兜底 1M / 0）。M19：直答会话键 =
 *  pairKey(viewer, agentId)（与后端边界同款推导）；独立会话（single）传
 *  opts.conversationId = sid + opts.agentId = 承载 Agent（sid 无 ~ 段，
 *  后端推导不出——同 session/archive 口径）。 */
export async function fetchSessionTokens(
  agentId: string,
  rpc: Rpc = wireRpc,
  opts?: { conversationId?: string; agentId?: string },
): Promise<SessionTokens> {
  const r = await rpc.call<{
    messageCount?: number;
    contextTokens?: number;
    maxContextTokens?: number;
    usagePercent?: number;
    avgTokensPerMsg?: number;
    estimatedMsgsRemaining?: number;
    status?: 'low' | 'moderate' | 'high' | 'critical';
    cache?: {
      lastHit?: number;
      lastMiss?: number;
      hit?: number;
      miss?: number;
      lastRunPrompt?: number;
    };
  }>('session/tokens', {
    conversationId: opts?.conversationId ?? [VIEWER_ID.value, agentId].sort().join('~'),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
  });
  return {
    tokenCount: r.contextTokens ?? 0,
    messageCount: r.messageCount ?? 0,
    maxContextTokens: r.maxContextTokens ?? 1_000_000,
    usagePercent: r.usagePercent ?? 0,
    avgTokensPerMsg: r.avgTokensPerMsg ?? 0,
    estimatedMsgsRemaining: r.estimatedMsgsRemaining ?? 0,
    status: r.status ?? 'low',
    ...(r.cache
      ? {
          cache: {
            lastHit: r.cache.lastHit ?? 0,
            lastMiss: r.cache.lastMiss ?? 0,
            hit: r.cache.hit ?? 0,
            miss: r.cache.miss ?? 0,
            lastRunPrompt: r.cache.lastRunPrompt ?? 0,
          },
        }
      : {}),
  };
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
