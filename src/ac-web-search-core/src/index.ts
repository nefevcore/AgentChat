// ============================================================
// ac-web-search-core —— web_search provider 纯库（零 cordis 依赖）
//
// src web/web-search 五 provider 原样平移（tavily/serpapi/brave/
// duckduckgo/deepseek 特型）。ac-web-tools 行消费；key 三源解析链
// （行配置 → ac-credentials → 环境变量）在行内组装。
// 2026-10 注册表收敛：只收经实证的 tavily/deepseek（未实测的三家
// 不保证可用，注册表摘除后行侧不可选）；实现文件与个体工厂导出保留，
// 需要时加回注册表一行即可。
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
import { createDeepSeekProvider } from './deepseek.ts';
import type { SearchProviderFactory } from './types.ts';

/** provider 注册表（工厂表；行侧按名取用）。2026-10 收敛：tavily/deepseek
 *  两个经实证 provider——serpapi/brave/duckduckgo 个体工厂仍导出但不在表 */
export const PROVIDER_REGISTRY: Record<string, SearchProviderFactory> = {
  tavily: createTavilyProvider,
  deepseek: createDeepSeekProvider,
};
