// ============================================================
// api/usage.ts —— 用量模块 Port B（preview 词汇直连，阶段二第一梯）
//
// 由适配器 REST 路由（/api/usage/tokens 拦截）整体迁入：preview
// usage/tokens 形状 → TokenUsage 视图契约（UsageSummary）的映射是
// 本模块自己的应用代码（视图模型归消费方，非翻译层）。
// 日期筛选（days/from/to）客户端执行——preview 只有按日聚合。
// ============================================================

import { wireRpc } from './wire.ts';

// ---- preview 形状（ac-usage 五查询的 RPC 结果镜像） ----

interface PUsageAggregate {
  runs?: number;
  steps?: number;
  prompt: number;
  completion: number;
  total?: number;
  lastContextPrompt?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

export interface PUsageResult {
  byAgent: Record<string, PUsageAggregate>;
  byModel: Record<string, PUsageAggregate>;
  byDay: Array<PUsageAggregate & { date: string }>;
  /** 按日 × 模型交叉聚合（「按模型」堆叠图；旧后端缺失 → by_day_llm 空） */
  byDayModel?: Array<PUsageAggregate & { date: string; model: string }>;
  byConversation: Record<string, PUsageAggregate>;
  /** 按端点对聚合（后端分类：user⇄agent / agent⇄agent；群与 singles 不进） */
  byPair?: Array<PUsageAggregate & { a: string; b: string }>;
  totals: PUsageAggregate;
}

/** Token 用量统计的日期范围参数（都不传 = 全部历史） */
export interface UsageRangeParams {
  /** 最近 N 天（含今日），如 30 */
  days?: number;
  /** 自定义区间起（YYYY-MM-DD，含） */
  from?: string;
  /** 自定义区间止（YYYY-MM-DD，含） */
  to?: string;
}

// ---- 视图契约（TokenUsage.vue 本地 UsageSummary 的镜像） ----

export interface UsageSummary {
  overall: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_react_steps: number;
    total_cache_hit: number;
    total_cache_miss: number;
    total_cache_hit_count: number;
    total_cache_miss_count: number;
    total_records: number;
    last_step_prompt_tokens?: number;
    last_step_total_tokens?: number;
  };
  by_agent: Array<{
    agent: string;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_react_steps: number;
    total_cache_hit: number;
    total_cache_miss: number;
    total_cache_hit_count: number;
    total_cache_miss_count: number;
    record_count: number;
    last_used: string;
  }>;
  by_day: Array<{
    date: string;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    record_count: number;
    total_cache_hit?: number;
    total_cache_miss?: number;
    last_step_prompt_tokens?: number;
    last_step_total_tokens?: number;
  }>;
  by_pair: Array<{ a: string; b: string; total_tokens: number; record_count: number }>;
  /** 按日期 × 模型聚合（「按模型」堆叠图；TokenUsage.buildChartDatasets 消费） */
  by_day_llm?: Array<{ date: string; llm: string; total_prompt_tokens: number; total_completion_tokens: number; total_tokens: number }>;
  range?: { from: string | null; to: string | null };
}

function aggRow(a: PUsageAggregate | undefined) {
  return {
    total_prompt_tokens: a?.prompt ?? 0,
    total_completion_tokens: a?.completion ?? 0,
    total_tokens: a?.total ?? (a?.prompt ?? 0) + (a?.completion ?? 0),
    total_react_steps: a?.steps ?? 0,
    total_cache_hit: a?.cacheHit ?? 0,
    total_cache_miss: a?.cacheMiss ?? 0,
    total_cache_hit_count: 0,
    total_cache_miss_count: 0,
    record_count: a?.runs ?? 0,
    last_used: '',
  };
}

/** preview usage/tokens → UsageSummary。
 *  by_pair 优先取后端 byPair（端点对已分类：user⇄agent + agent⇄agent 委托，
 *  群/独立会话不进）；旧后端无 byPair 时从 byConversation 推导 fallback
 *  （1v1 会话键 = agentId → user↔agent 弦；含 '~' 与未知名跳过——
 *  旧推导曾把群 gid / singles sid 误挂成弦端）。 */
export function toUsageSummary(u: PUsageResult, agentIds: Set<string> = new Set()): UsageSummary {
  const byAgent = Object.entries(u.byAgent ?? {}).map(([agent, a]) => ({ agent, ...aggRow(a) }));
  const byDay = (u.byDay ?? []).map((d) => ({
    date: d.date,
    ...aggRow(d),
    last_step_prompt_tokens: d.lastContextPrompt ?? 0,
  }));
  let byPair: UsageSummary['by_pair'];
  if (Array.isArray(u.byPair)) {
    byPair = u.byPair.map((p) => ({
      a: p.a,
      b: p.b,
      total_tokens: p.total ?? (p.prompt ?? 0) + (p.completion ?? 0),
      record_count: p.runs ?? 0,
    }));
  } else {
    byPair = [];
    for (const [conv, a] of Object.entries(u.byConversation ?? {})) {
      if (!a || (a.total ?? a.prompt) <= 0) continue;
      if (conv.includes('~')) continue; // 委托对键：旧后端未分类，跳过（防错挂）
      if (agentIds.size > 0 && !agentIds.has(conv)) continue; // 群/singles/未知名
      byPair.push({ a: 'user', b: conv, total_tokens: a.total ?? (a.prompt ?? 0) + (a.completion ?? 0), record_count: a.runs ?? 0 });
    }
  }
  const dates = byDay.map((d) => d.date).sort();
  const byDayLlm = (u.byDayModel ?? []).map((r) => ({
    date: r.date,
    llm: r.model,
    total_prompt_tokens: r.prompt ?? 0,
    total_completion_tokens: r.completion ?? 0,
    total_tokens: r.total ?? (r.prompt ?? 0) + (r.completion ?? 0),
  }));
  return {
    overall: {
      ...aggRow(u.totals),
      total_records: u.totals?.runs ?? 0,
      last_step_prompt_tokens: u.totals?.lastContextPrompt ?? 0,
    },
    by_agent: byAgent,
    by_day: byDay,
    by_pair: byPair,
    by_day_llm: byDayLlm,
    range: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : { from: null, to: null },
  };
}

/** 日期范围过滤：by_day/by_day_llm 行过滤 + overall 从过滤行重算（by_agent/by_pair 无日期维度，近似全量） */
export function filterUsageRange(summary: UsageSummary, params: UsageRangeParams): UsageSummary {
  if (!params.days && !params.from && !params.to) return summary;
  const cutoff = params.days ? Date.now() - params.days * 86_400_000 : 0;
  const fromDay = params.from ?? '0000-00-00';
  const toDay = params.to ?? '9999-99-99';
  const inRange = (date: string) => date >= fromDay && date <= toDay && (!params.days || new Date(date).getTime() >= cutoff);
  const rows = summary.by_day.filter((d) => inRange(d.date));
  const llmRows = (summary.by_day_llm ?? []).filter((d) => inRange(d.date));
  const sum = (pick: (d: UsageSummary['by_day'][number]) => number) => rows.reduce((s, d) => s + pick(d), 0);
  return {
    ...summary,
    by_day: rows,
    by_day_llm: llmRows,
    overall: {
      ...summary.overall,
      total_prompt_tokens: sum((d) => d.total_prompt_tokens),
      total_completion_tokens: sum((d) => d.total_completion_tokens),
      total_tokens: sum((d) => d.total_tokens),
      total_records: sum((d) => d.record_count),
    },
  };
}

/** Token 用量统计（TokenUsage.vue 数据源；rpc 可注入供测试）。
 *  聚合 agents/list 名册（旧后端 byPair fallback 的端点判别用；失败容忍）。 */
export async function fetchUsageTokens(
  params: UsageRangeParams = {},
  rpc: { call<T>(method: string, p?: Record<string, unknown>): Promise<T> } = wireRpc,
): Promise<UsageSummary> {
  const [raw, agentsR] = await Promise.all([
    rpc.call<PUsageResult>('usage/tokens'),
    rpc.call<{ agents?: Array<{ id: string }> }>('agents/list').catch(() => undefined),
  ]);
  return filterUsageRange(
    toUsageSummary(raw, new Set((agentsR?.agents ?? []).map((a) => a.id))),
    params,
  );
}
