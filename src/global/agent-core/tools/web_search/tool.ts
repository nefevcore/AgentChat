// ============================================================
// web_search 工具 —— 多搜索 API 路由层
//
// 支持的搜索 API（按需配置）：
//   · Tavily       — AI 优化搜索引擎，每月 1000 次免费
//   · SerpAPI      — Google/Bing 结构化结果，每月 100 次免费
//   · Brave Search — 隐私优先独立搜索引擎，每月 2000 次免费
//   · DuckDuckGo   — 即时答案 API，完全免费，无需 API Key
//
// 配置方式：
//   在 workspace/config.json 或 Agent config.json 中设置：
//     "tool.web_search": { "provider": "tavily" }
//
// 环境变量（按所选 provider 配置）：
//   TAVILY_API_KEY   — Tavily
//   SERPAPI_API_KEY  — SerpAPI
//   BRAVE_API_KEY    — Brave Search
//   （DuckDuckGo 无需任何 Key）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { resolveNamespaceConfig } from '@core/config';
import { getCredential } from '@core/credential-store';
import type { SearchProvider, SearchParams, ProviderConfig } from './types';
import type { SearchProviderFactory } from './types';

// ── Provider 注册表 ──
import { createTavilyProvider } from './providers/tavily';
import { createSerpApiProvider } from './providers/serpapi';
import { createBraveProvider } from './providers/brave';
import { createDuckDuckGoProvider } from './providers/duckduckgo';

/** 所有已注册的 provider 工厂 */
const PROVIDER_REGISTRY: Record<string, SearchProviderFactory> = {
  tavily: createTavilyProvider,
  serpapi: createSerpApiProvider,
  brave: createBraveProvider,
  duckduckgo: createDuckDuckGoProvider,
};

/** 默认 provider */
const DEFAULT_PROVIDER = 'tavily';

// ── 运行时配置 ──

export interface WebSearchConfig {
  provider: string;
  tavilyApiKey: string;
  serpapiApiKey: string;
  braveApiKey: string;
  defaultResults: number;
  defaultDepth: 'basic' | 'advanced';
  defaultTopic: 'general' | 'news' | 'finance';
  rawContentMaxLen: number;
}

function defaults(): WebSearchConfig {
  return {
    provider: DEFAULT_PROVIDER,
    tavilyApiKey: '',
    serpapiApiKey: '',
    braveApiKey: '',
    defaultResults: 5,
    defaultDepth: 'advanced',
    defaultTopic: 'general',
    rawContentMaxLen: 2000,
  };
}

export function resolveWebSearchConfig(runtimeCfg?: Record<string, Record<string, unknown>>): WebSearchConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeCfg);
}

/** 从 WebSearchConfig 解析 API Key（config → 凭据存储 → 环境变量） */
function resolveApiKey(cfg: WebSearchConfig, providerId: string): string {
  const cfgMap: Record<string, string> = {
    tavily: cfg.tavilyApiKey,
    serpapi: cfg.serpapiApiKey,
    brave: cfg.braveApiKey,
    duckduckgo: '',
  };
  // 1) config 中直接配置的值
  const fromConfig = cfgMap[providerId];
  if (fromConfig) return fromConfig;

  // 2) 凭据存储：按 $ref（池引用）查找
  const $ref = (cfg as any).$ref as string | undefined;
  if ($ref) {
    const fromCred = getCredential('__global__', `searchpool:${$ref}`);
    if (fromCred) return fromCred;
  }

  // 3) 凭据存储：自动查找 default 池条目
  const { getGlobalConfig } = require('@core/config');
  const pools = getGlobalConfig().searchProviders as Record<string, Record<string, unknown>>;
  const entries = Object.entries(pools).filter(([k]) => !k.startsWith('$'));
  const def = entries.find(([_, v]) => v && (v as any).default);
  if (def) {
    const fromPool = getCredential('__global__', `searchpool:${def[0]}`);
    if (fromPool) return fromPool;
  }

  // 4) 凭据存储：按 provider 名称查找
  const fromCredDirect = getCredential('__global__', providerId);
  if (fromCredDirect) return fromCredDirect;

  // 5) 环境变量回退
  const envMap: Record<string, string> = {
    tavily: 'TAVILY_API_KEY',
    serpapi: 'SERPAPI_API_KEY',
    brave: 'BRAVE_API_KEY',
  };
  const envVar = envMap[providerId];
  if (envVar && process.env[envVar]) return process.env[envVar]!;

  return '';
}

/** 构建 provider 运行时配置 */
function buildProviderConfig(cfg: WebSearchConfig, providerId: string): ProviderConfig {
  const apiKey = resolveApiKey(cfg, providerId);
  return { apiKey };
}

/** 按名称获取 provider 实例（带校验） */
function getProvider(providerName: string, cfg: WebSearchConfig): SearchProvider {
  const factory = PROVIDER_REGISTRY[providerName];
  if (!factory) {
    const available = Object.keys(PROVIDER_REGISTRY).join(', ');
    throw new Error(`未知的搜索 provider "${providerName}"。可用选项：${available}`);
  }
  const provider = factory();
  provider.validateConfig(buildProviderConfig(cfg, providerName));
  return provider;
}

/** 截断原始内容 */
function truncateRawContent(results: Array<{ raw_content?: string | null }>, maxLen: number): void {
  for (const r of results) {
    if (r.raw_content && r.raw_content.length > maxLen) {
      r.raw_content = r.raw_content.substring(0, maxLen) + '…';
    }
  }
}

// ── Tool 定义 ──

export const tool: Tool = {
  ...meta,
  extractLabel: (args) => args.query || '',
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '实时网络搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词或自然语言查询。',
          },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: '默认 advanced。',
          },
          max_results: {
            type: 'number',
            description: '最大返回结果数（1-20），默认 5。',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            description: '默认 general。',
          },
          include_domains: {
            type: 'array',
            description: '限定域名（可选）。',
            items: { type: 'string' },
          },
          exclude_domains: {
            type: 'array',
            description: '排除域名（可选）。',
            items: { type: 'string' },
          },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'],
            description: '按时间过滤（可选）。',
          },
          include_answer: {
            type: 'boolean',
            description: '是否包含 AI 答案摘要，默认 false。',
          },
          include_raw_content: {
            type: 'boolean',
            description: '是否包含原始页面内容，默认 false。',
          },
        },
        required: ['query'],
      },
    },
  },

  async execute(args: Record<string, any>, stream): Promise<string> {
    try {
      const wsCfg = resolveWebSearchConfig();
      const providerName = wsCfg.provider;
      const providerCfg = buildProviderConfig(wsCfg, providerName);
      const provider = getProvider(providerName, wsCfg);

      stream?.onChunk?.(`正在使用 ${provider.label} 搜索: ${args.query}...\n`);

      // 构建标准化参数
      const params: SearchParams = {
        query: args.query as string,
        search_depth: (args.search_depth as SearchParams['search_depth']) ?? wsCfg.defaultDepth,
        max_results: (args.max_results as number) ?? wsCfg.defaultResults,
        topic: (args.topic as SearchParams['topic']) ?? wsCfg.defaultTopic,
      };

      if (args.include_domains?.length) params.include_domains = args.include_domains as string[];
      if (args.exclude_domains?.length) params.exclude_domains = args.exclude_domains as string[];
      if (args.time_range) params.time_range = args.time_range as SearchParams['time_range'];
      if (args.include_answer !== undefined) params.include_answer = args.include_answer as boolean;
      if (args.include_raw_content !== undefined) params.include_raw_content = args.include_raw_content as boolean;

      // 执行搜索
      const data = await provider.search(params, providerCfg);

      // 截断原始内容
      truncateRawContent(data.results, wsCfg.rawContentMaxLen);

      stream?.onChunk?.(
        `搜索完成，找到 ${data.results.length} 个结果` +
        (data.answer ? '（含 AI 摘要）' : '') +
        ` (${data.response_time.toFixed(1)}s)\n`
      );

      return JSON.stringify({
        status: 'success',
        provider: providerName,
        data: {
          query: data.query,
          results: data.results,
          answer: data.answer ?? null,
          response_time: data.response_time,
          credits_used: data.credits_used ?? null,
        },
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: {
          query: args.query,
          message: err.message || String(err),
        },
      });
    }
  },
};
