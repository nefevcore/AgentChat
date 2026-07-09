// ============================================================
// web_search 工具 —— 调用 Tavily Search API 进行网络搜索
//
// Tavily 是面向 AI Agent 的实时搜索引擎，返回干净的结构化内容。
// 文档：https://docs.tavily.com
// API 参考：https://docs.tavily.com/documentation/api-reference/endpoint/search
//
// 环境变量：
//   TAVILY_API_KEY — Tavily API 密钥（必填，从 https://app.tavily.com 获取）
// ============================================================

import { Tool } from '../../../core/types';
import { resolveWebSearchConfig } from './config';

/** Tavily Search API 端点 */
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/** 从环境变量获取 API Key */
function getApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    throw new Error(
      '未配置 TAVILY_API_KEY 环境变量。请在 .env 文件中设置 TAVILY_API_KEY，' +
      '可前往 https://app.tavily.com 免费获取（每月 1000 次免费额度）。'
    );
  }
  return key;
}

/** Tavily Search 请求参数 */
interface TavilySearchParams {
  query: string;
  search_depth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  max_results?: number;
  topic?: 'general' | 'news' | 'finance';
  include_domains?: string[];
  exclude_domains?: string[];
  include_answer?: boolean | 'basic' | 'advanced';
  include_raw_content?: boolean | 'markdown' | 'text';
  include_images?: boolean;
  time_range?: 'day' | 'week' | 'month' | 'year' | 'd' | 'w' | 'm' | 'y';
  country?: string;
  auto_parameters?: boolean;
}

/** Tavily 搜索结果单项 */
interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
  favicon?: string;
  images?: Array<{ url: string; description?: string }>;
}

/** Tavily Search 完整响应 */
interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  images?: Array<{ url: string; description?: string }>;
  response_time: number;
  usage?: { credits: number };
  request_id?: string;
}

/** 网络搜索工具，调用 Tavily Search API 进行实时搜索 */
export const tool: Tool = {
  displayName: '搜索',
  description: '实时网络搜索',
  extractLabel: (args) => args.query || '',
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '实时网络搜索',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询字符串。建议使用自然语言描述你想查找的内容。',
          },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced', 'fast', 'ultra-fast'],
            description:
              '搜索结果深度。"advanced" 返回最相关的内容（每个来源多段摘要），' +
              '"basic" 平衡延迟与相关性，"fast"/"ultra-fast" 优先低延迟。' +
              '默认 "advanced"。',
          },
          max_results: {
            type: 'number',
            description: '最大返回结果数（1-20），默认 5。',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            description:
              '搜索类别。"general" 为通用搜索，"news" 适合实时新闻，' +
              '"finance" 适合财经数据。默认 "general"。',
          },
          include_domains: {
            type: 'array',
            description: '限定在这些域名内搜索，最多 300 个。',
            items: { type: 'string' },
          },
          exclude_domains: {
            type: 'array',
            description: '从搜索结果中排除这些域名，最多 150 个。',
            items: { type: 'string' },
          },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'],
            description:
              '按发布日期过滤结果的时间范围。例如 "day" 仅今天，"week" 最近一周。',
          },
          include_answer: {
            type: 'boolean',
            description:
              '是否在结果中包含 LLM 生成的简短答案摘要。默认 false。',
          },
          include_raw_content: {
            type: 'boolean',
            description:
              '是否包含搜索结果的原始页面内容（Markdown 格式）。默认 false。',
          },
        },
        required: ['query'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    try {
      const apiKey = getApiKey();

      // 构建请求体
      const wsCfg = resolveWebSearchConfig();
      const params: TavilySearchParams = {
        query: args.query as string,
        search_depth: (args.search_depth as TavilySearchParams['search_depth']) ?? wsCfg.defaultDepth,
        max_results: (args.max_results as number) ?? wsCfg.defaultResults,
        topic: (args.topic as TavilySearchParams['topic']) ?? wsCfg.defaultTopic,
      };

      // 可选参数仅在明确提供时才添加
      if (args.include_domains?.length) {
        params.include_domains = args.include_domains as string[];
      }
      if (args.exclude_domains?.length) {
        params.exclude_domains = args.exclude_domains as string[];
      }
      if (args.time_range) {
        params.time_range = args.time_range as TavilySearchParams['time_range'];
      }
      if (args.include_answer !== undefined) {
        params.include_answer = args.include_answer as boolean;
      }
      if (args.include_raw_content !== undefined) {
        params.include_raw_content = args.include_raw_content as boolean;
      }

      // 发起 API 请求
      const response = await fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Tavily API 返回错误 (${response.status})`;
        try {
          const err = JSON.parse(errorBody);
          if (err.detail?.error) {
            errorMsg += `：${err.detail.error}`;
          }
        } catch {
          if (errorBody) errorMsg += `：${errorBody}`;
        }
        return errorMsg;
      }

      const data = (await response.json()) as TavilyResponse;

      // 构建结构化结果
      const results = data.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        raw_content: r.raw_content ?? null,
      }));

      return JSON.stringify({
        status: 'success',
        data: {
          query: params.query,
          results,
          answer: data.answer ?? null,
          response_time: data.response_time,
          credits_used: data.usage?.credits ?? null,
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
