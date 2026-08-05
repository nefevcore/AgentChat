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
import { resolveNamespaceConfig } from '@agents/config';
import { getCredential } from '@agents/credential-store';
import type { SearchProvider, SearchParams, ProviderConfig } from './types';
import type { SearchProviderFactory } from './types';
import * as fs from 'fs';
import * as path from 'path';

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
  /** 月配额（搜索次数）。0 = 不限制 */
  quota: number;
  /** 额度记账文件路径（默认 workspace/.web_search_credits.json） */
  creditsFile: string;
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
    quota: 0,
    creditsFile: '',
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
  const { getGlobalConfig } = require('@agents/config');
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

// ── 额度记账（本地配额检查）──

/**
 * 读取额度记账：{ [provider]: { [YYYY-MM]: 已用次数 } }
 * 无配额配置（quota=0）时跳过检查。
 */
function readCredits(creditsFile: string): Record<string, Record<string, number>> {
  try {
    if (fs.existsSync(creditsFile)) {
      return JSON.parse(fs.readFileSync(creditsFile, 'utf-8')) as Record<string, Record<string, number>>;
    }
  } catch (err: any) {
    console.warn(`[web_search] 额度记账文件读取失败（${err.message}），重置`);
  }
  return {};
}

/** 写入额度记账（原子写：先写临时文件再 rename） */
function writeCredits(creditsFile: string, data: Record<string, Record<string, number>>): void {
  try {
    fs.mkdirSync(path.dirname(creditsFile), { recursive: true });
    const tmp = creditsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, creditsFile);
  } catch (err: any) {
    console.warn(`[web_search] 额度记账写入失败: ${err.message}`);
  }
}

/** 当前月份键（YYYY-MM） */
function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 查询前额度检查。返回错误信息（额度不足时），null 表示可继续。
 */
function checkQuota(cfg: WebSearchConfig, providerName: string): string | null {
  const quota = cfg.quota ?? 0;
  if (!quota || quota <= 0) return null; // 未配置配额 → 不限制

  const file = cfg.creditsFile || '';
  if (!file) return null; // 无记账文件 → 不限制

  const credits = readCredits(file);
  const used = credits[providerName]?.[monthKey()] ?? 0;
  if (used >= quota) {
    return `搜索额度已用完：${providerName} 本月已用 ${used} 次（配额 ${quota} 次）。` +
      '请更换 provider（如 duckduckgo 免费无限）或联系管理员调整 quota 配置。';
  }
  return null;
}

/** 记录一次搜索用量 */
function recordUsage(cfg: WebSearchConfig, providerName: string, creditsUsed: number | null | undefined): void {
  const file = cfg.creditsFile || '';
  if (!file) return;
  const credits = readCredits(file);
  const provider = credits[providerName] ?? {};
  const mk = monthKey();
  provider[mk] = (provider[mk] ?? 0) + (creditsUsed ?? 1); // credits 缺失时按 1 计
  credits[providerName] = provider;
  writeCredits(file, credits);
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

      // 默认记账文件：<workspace>/.web_search_credits.json；相对路径基于 workspaceDir 解析
      if (!wsCfg.creditsFile) {
        const { getGlobalConfig } = require('@agents/config') as typeof import('@agents/config');
        wsCfg.creditsFile = path.join(getGlobalConfig().workspaceDir, '.web_search_credits.json');
      } else if (!path.isAbsolute(wsCfg.creditsFile)) {
        const { getGlobalConfig } = require('@agents/config') as typeof import('@agents/config');
        wsCfg.creditsFile = path.join(getGlobalConfig().workspaceDir, wsCfg.creditsFile);
      }

      // 查询前额度检查：额度不足 → 返回明确错误（Agent 能识别失败原因）
      const quotaErr = checkQuota(wsCfg, providerName);
      if (quotaErr) {
        stream?.onChunk?.(`⚠️ ${quotaErr}\n`);
        return JSON.stringify({
          status: 'quota_exhausted',
          provider: providerName,
          data: {
            query: args.query,
            message: quotaErr,
          },
        });
      }

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

      // 记录用量（credits_used 缺失时按 1 计）
      recordUsage(wsCfg, providerName, data.credits_used);

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
