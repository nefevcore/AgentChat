// ============================================================
// Tavily Search Provider
//
// Tavily 是面向 AI Agent 的实时搜索引擎，返回干净的结构化内容。
// 文档：https://docs.tavily.com
// 每月 1000 次免费额度（https://app.tavily.com）
// ============================================================

import type { SearchProvider, SearchParams, SearchResponse, ProviderConfig } from '../types';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export function createTavilyProvider(): SearchProvider {
  return {
    id: 'tavily',
    label: 'Tavily',
    description: '面向 AI Agent 的实时搜索引擎，返回结构化内容',

    validateConfig(cfg: ProviderConfig): void {
      if (!cfg.apiKey) {
        throw new Error(
          '未配置 Tavily API 密钥。请在池条目的 API 密钥字段中设置。' +
          '可前往 https://app.tavily.com 免费获取（每月 1000 次免费额度）。'
        );
      }
    },

    async search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse> {
      const apiKey = cfg.apiKey;

      // 构建 Tavily 专用请求体
      const body: Record<string, unknown> = {
        query: params.query,
        search_depth: params.search_depth === 'basic' ? 'basic' : 'advanced',
        max_results: params.max_results ?? 5,
        topic: params.topic ?? 'general',
      };

      if (params.include_domains?.length) body.include_domains = params.include_domains;
      if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
      if (params.time_range) body.time_range = params.time_range;
      if (params.include_answer !== undefined) body.include_answer = params.include_answer ? 'advanced' : false;
      if (params.include_raw_content !== undefined) body.include_raw_content = params.include_raw_content;

      const response = await fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Tavily API 返回错误 (${response.status})`;
        try {
          const err = JSON.parse(errorBody);
          if (err.detail?.error) errorMsg += `：${err.detail.error}`;
        } catch {
          if (errorBody) errorMsg += `：${errorBody}`;
        }
        throw new Error(errorMsg);
      }

      const data = await response.json() as any;

      return {
        query: data.query,
        results: (data.results ?? []).map((r: any) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score,
          raw_content: r.raw_content ?? null,
        })),
        answer: data.answer ?? null,
        response_time: data.response_time,
        credits_used: data.usage?.credits ?? null,
      };
    },

    configuration: [],
  };
}
