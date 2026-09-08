// ============================================================
// ac-client-ui-conversation/client/rosterApi.ts —— 名册/池/Token
// 直连数据面（M27.2-2 conversation 视图半边随件迁）
//
// DialogView（Token 仪表 + 删除 Agent）与 ChatInput（模型菜单 +
// 发现缓存）的消费子集；rpc 必传（RpcClientFace 契约面——webui
// api/roster.ts 薄包装补 wireRpc 缺省维持旧路径）。其余名册写面
//（createAgent/头像 HTTP 面/llm providers 等）消费面在 settings/
// sidebar，仍归 webui api/roster.ts。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import { VIEWER_ID } from './viewer.ts';

type Rpc = Pick<RpcClientFace, 'call'>;

/** 会话 Token 用量返回形（session/tokens 归一面——webui 同款） */
export interface SessionTokens {
  tokenCount?: number;
  messageCount?: number;
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
}

/** 会话 Token 用量（session/tokens 全量透传；直答会话键 = pairKey
 *  与后端边界同款推导；独立会话（single）传 opts.conversationId = sid
 *  + opts.agentId = 承载 Agent） */
export async function fetchSessionTokens(
  agentId: string,
  rpc: Rpc,
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

/** 删除 Agent（agents/delete） */
export async function deleteAgent(agentId: string, rpc: Rpc): Promise<{ success?: boolean; error?: string }> {
  await rpc.call('agents/delete', { agentId });
  return { success: true };
}

/** Provider 池（config/get 白名单域合成；ChatInput 模型菜单数据源） */
export async function fetchPools(
  rpc: Rpc,
): Promise<{ llmProviders: Record<string, Record<string, unknown>>; searchProviders: Record<string, Record<string, unknown>> }> {
  const r = await rpc.call<{ config?: Record<string, unknown> }>('config/get');
  const cfg = r.config ?? {};
  return {
    llmProviders: (cfg.llmProviders ?? cfg.llm ?? {}) as Record<string, Record<string, unknown>>,
    searchProviders: (cfg.searchProviders ?? {}) as Record<string, Record<string, unknown>>,
  };
}

/** 模型能力元数据条目（与后端 PoolModelEntry 同形） */
export interface PoolModelMeta {
  model: string;
  vision?: true;
  hidden?: true;
}

/** 池条目 models 宽容归一（读侧唯一解析点）：裸名 string / 对象
 *  {model, vision?, hidden?} 双形态 → 统一对象形态（webui 同款）。 */
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
