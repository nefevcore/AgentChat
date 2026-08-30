// ============================================================
// ac-web-search-core —— web_search provider 纯库（零 cordis 依赖）
//
// src web/web-search 五 provider 原样平移（tavily/serpapi/brave/
// duckduckgo/deepseek 特型）。ac-web-tools 行消费；key 三源解析链
// （行配置 → ac-credentials → 环境变量）在行内组装。
// ============================================================
export type {
  ProviderConfig,
  SearchResult,
  SearchResponse,
  SearchParams,
  SearchProvider,
  SearchProviderFactory,
} from './types.ts';
export { createTavilyProvider } from './tavily.ts';
export { createSerpApiProvider } from './serpapi.ts';
export { createBraveProvider } from './brave.ts';
export { createDuckDuckGoProvider } from './duckduckgo.ts';
export { createDeepSeekProvider, parseSourceSummaries, extractAnswer, mapAnthropicResponse } from './deepseek.ts';
export type { DeepSeekSource } from './deepseek.ts';

import { createTavilyProvider } from './tavily.ts';
import { createSerpApiProvider } from './serpapi.ts';
import { createBraveProvider } from './brave.ts';
import { createDuckDuckGoProvider } from './duckduckgo.ts';
import { createDeepSeekProvider } from './deepseek.ts';
import type { SearchProviderFactory } from './types.ts';

/** provider 注册表（工厂表；行侧按名取用） */
export const PROVIDER_REGISTRY: Record<string, SearchProviderFactory> = {
  tavily: createTavilyProvider,
  serpapi: createSerpApiProvider,
  brave: createBraveProvider,
  duckduckgo: createDuckDuckGoProvider,
  deepseek: createDeepSeekProvider,
};
