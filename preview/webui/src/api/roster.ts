// ============================================================
// api/roster.ts —— Agent 名册 Port B（阶段二第三梯）
//
// agents 名册/写侧/模型/池/会话 Token 直连（rpc 词汇）；头像三端点
// 是 preview 真实 HTTP multipart 面，直连 fetch。AgentInfo 合成
// （name←description 等）是本模块视图代码——迁移自适配器 shapes。
// ============================================================

import { wireRpc } from './wire.ts';
import { VIEWER_ID } from '../constants';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ---- preview 形状 ----

export interface PAgentConfig {
  id: string;
  model?: string;
  provider?: string;
  virtual?: boolean;
  system?: string;
  description?: string;
  /** 能力标签（P6：requires 门禁词表；'base' 内建，UI 恒视作具备） */
  tags?: string[];
  llmParams?: Record<string, unknown>;
  tools?: unknown;
  /** 具名扩展设置（M24 X1：hooks→settings；键 = 行名 / 动态插件名） */
  settings?: Record<string, unknown>;
  maxSteps?: number;
}

interface SrcAgentInfo {
  id: string;
  name: string;
  description: string;
  avatar?: string | null;
  lastActivity?: number;
  /** 最后一条消息摘要（P4：runs/snapshot 尾部记录合成；实时侧由 bumpAgent 覆盖） */
  lastMessage?: {
    role: string;
    content: string;
    timestamp: string;
    agent_id?: string;
  } | null;
  virtual?: boolean;
  hasActiveSession?: boolean;
  /** 能力标签（AgentListPane 徽章 / 搜索过滤） */
  tags?: string[];
}

/** snapshot 会话尾部摘要（runs/snapshot conversations[].last） */
interface PConvTail {
  conversationId: string;
  updatedAt?: number;
  last?: { role: string; text: string; ts: string; agent_id?: string; name?: string };
}

/** AgentConfig[] + running + snapshot → AgentInfo[]（名册合成：name←description；
 *  头像恒指真实端点，404 由 <img> onerror 回退；P4/M19：名册活动源 =
 *  viewer⇄agent 直答对桶 pairKey(viewer, agent)——lastActivity ← 桶
 *  updatedAt，lastMessage ← 尾部记录（说话人 = 尾部 name） */
export function toAgentList(
  configs: PAgentConfig[],
  running: Array<{ agentId: string; conversationId: string }> = [],
  conversations: PConvTail[] = [],
): { agents: SrcAgentInfo[] } {
  const runningAgents = new Set(running.map((r) => r.agentId));
  // 对桶 → 名册键（viewer 对桶取另一端；旧 agentId 桶直存兜底）
  const viewer = VIEWER_ID.value;
  const convOf = new Map<string, PConvTail>();
  for (const c of conversations) {
    if (c.conversationId.includes('~')) {
      const parts = c.conversationId.split('~');
      if (parts.length === 2 && parts.includes(viewer)) {
        const other = parts[0] === viewer ? parts[1] : parts[0];
        const prev = convOf.get(other);
        if (!prev || (c.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) convOf.set(other, c);
      }
    } else {
      convOf.set(c.conversationId, c);
    }
  }
  return {
    agents: configs.map((c) => {
      const conv = convOf.get(c.id);
      const last = conv?.last;
      return {
        id: c.id,
        name: c.description ?? c.id,
        description: c.description ?? '',
        avatar: `/api/agents/${encodeURIComponent(c.id)}/avatar`,
        virtual: c.virtual,
        hasActiveSession: runningAgents.has(c.id),
        ...(Array.isArray(c.tags) ? { tags: c.tags } : {}),
        ...(conv?.updatedAt ? { lastActivity: conv.updatedAt } : {}),
        ...(last
          ? {
              lastMessage: {
                // 中性格式（D13）：归属优先 agent_id，旧 baked 行回落 name；
                // 气泡侧 = 说话人是否 viewer（旧 user 行视作 viewer 侧）
                role:
                  last.role === 'user' ||
                  (last.agent_id ?? last.name) === viewer
                    ? 'user'
                    : 'agent',
                content: last.text.slice(0, 80),
                timestamp: last.ts,
                agent_id: last.agent_id ?? last.name ?? (last.role === 'user' ? 'user' : c.id),
              },
            }
          : {}),
      };
    }),
  };
}

// ---- 名册 ----

/** Agent 名册（建群弹窗/设置面 loadMeta 数据源；P4：聚合 runs/snapshot
 *  取 1v1 会话 lastActivity/lastMessage——snapshot 失败静默降级旧形态） */
export async function fetchAgents(rpc: Rpc = wireRpc): Promise<{ agents: SrcAgentInfo[] }> {
  const [agentsR, statsR, snapR] = await Promise.all([
    rpc.call<{ agents: PAgentConfig[] }>('agents/list'),
    rpc.call<{ running: Array<{ agentId: string; conversationId: string }> }>('conversation/stats'),
    rpc
      .call<{ conversations?: Array<{ conversationId: string; updatedAt?: number; last?: { role: string; text: string; ts: string; name?: string } }> }>('runs/snapshot')
      .catch(() => undefined),
  ]);
  return toAgentList(agentsR.agents ?? [], statsR.running ?? [], snapR?.conversations ?? []);
}

/** 创建 Agent（src 形状 → preview AgentConfig 白名单） */
export async function createAgent(
  payload: { id?: string; name?: string; provider?: string; llm?: Record<string, unknown>; tools?: unknown },
  rpc: Rpc = wireRpc,
): Promise<{ success?: boolean; agentId?: string; error?: string }> {
  const config: Record<string, unknown> = {};
  if (payload.id) config.id = payload.id;
  if (payload.name) config.description = payload.name;
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

/** 模型清单（llm/providers stats 拼近似；AgentPane「从 API 读取」） */
export async function fetchAgentModels(_params = '', rpc: Rpc = wireRpc): Promise<{ models?: string[] }> {
  void _params;
  const r = await rpc.call<{ stats?: Array<{ models?: string[] }> }>('llm/providers');
  return { models: [...new Set((r.stats ?? []).flatMap((s) => s.models ?? []))] };
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
}

/** 会话 Token 用量（session/tokens 全量透传：tokenCount = lastContextPrompt，
 *  usagePercent / avgTokensPerMsg / estimatedMsgsRemaining 由后端按归档预算
 *  maxContextTokens 派生——缺省兜底 1M / 0）。M19：直答会话键 =
 *  pairKey(viewer, agentId)（与后端边界同款推导） */
export async function fetchSessionTokens(agentId: string, rpc: Rpc = wireRpc): Promise<SessionTokens> {
  const r = await rpc.call<{
    messageCount?: number;
    lastContextPrompt?: number;
    maxContextTokens?: number;
    usagePercent?: number;
    avgTokensPerMsg?: number;
    estimatedMsgsRemaining?: number;
    status?: 'low' | 'moderate' | 'high' | 'critical';
  }>('session/tokens', { conversationId: [VIEWER_ID.value, agentId].sort().join('~') });
  return {
    tokenCount: r.lastContextPrompt ?? 0,
    messageCount: r.messageCount ?? 0,
    maxContextTokens: r.maxContextTokens ?? 1_000_000,
    usagePercent: r.usagePercent ?? 0,
    avgTokensPerMsg: r.avgTokensPerMsg ?? 0,
    estimatedMsgsRemaining: r.estimatedMsgsRemaining ?? 0,
    status: r.status ?? 'low',
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

// ---- 预设 Agent 目录（独立会话选用 UI / 空会话默认路由目标；ac-agent-presets 物化） ----

export interface AgentPresetInfo {
  id: string;
  name: string;
  label: string;
  description: string;
  default: boolean;
}

export async function fetchAgentPresets(rpc: Rpc = wireRpc): Promise<{ presets: AgentPresetInfo[] }> {
  const r = await rpc.call<{ presets?: AgentPresetInfo[] }>('agents/presets');
  return { presets: r.presets ?? [] };
}
