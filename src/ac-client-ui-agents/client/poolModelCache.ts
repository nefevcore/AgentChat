// ============================================================
// client/poolModelCache.ts —— provider × 模型缓存加载（并源：
// cr-299 批 3——AgentListPane 快建弹窗与首启向导第 4 步共用，
// 原两处各写一份迟早漂移）
//
// 数据源：llm/providers 注册面（stats）+ 池发现缓存（config llmProviders
// 条目 models 裸 string 清单）。模型选项只列真实存在的模型（静态缺省
// 清单不进选项——P5 口径）。
// ============================================================
import { fetchLlmProviders, type LlmProviderStat } from './index.ts';
import { fetchPools } from './rosterApi.ts';
import { defaultRpc } from 'ac-client-ui-settings/client/rpcDefault.ts';

/** provider 注册面 + 池发现模型缓存（Agent 快建/引导创建的模型下拉数据源） */
export interface PoolModelCache {
  stats: LlmProviderStat[];
  /** provider 名 → 发现缓存的模型清单（裸 string 形态） */
  models: Record<string, string[]>;
}

/** 拉取注册面与池发现缓存（失败静默空态——RPC 失败回落空清单） */
export async function loadPoolModelCache(): Promise<PoolModelCache> {
  const [statsR, poolsR] = await Promise.all([
    fetchLlmProviders(defaultRpc).then((r) => r.stats).catch(() => []),
    fetchPools(defaultRpc).then((r) => r.llmProviders).catch(() => ({})),
  ]);
  const cache: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(poolsR as Record<string, { models?: unknown }>)) {
    if (name.startsWith('$') || !Array.isArray(entry.models)) continue;
    cache[name] = entry.models.filter((m): m is string => typeof m === 'string');
  }
  return { stats: statsR, models: cache };
}
