// ============================================================
// ac-web-search-core/src/tavily.ts —— Tavily Search Provider（src 原样平移）
// ============================================================
import type { ProviderConfig, SearchParams, SearchProvider, SearchResponse } from './types.ts';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export function createTavilyProvider(): SearchProvider {
  return {
    id: 'tavily',
    label: 'Tavily',
    description: '面向 AI Agent 的实时搜索引擎，返回结构化内容',

    validateConfig(cfg: ProviderConfig): void {
      if (!cfg.apiKey) {
        throw new Error(
          '未配置 Tavily API 密钥。可前往 https://app.tavily.com 免费获取（每月 1000 次免费额度）。',
        );
      }
    },

    async search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse> {
      const apiKey = cfg.apiKey;

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

      const startTime = Date.now();
      const response = await fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const responseTime = (Date.now() - startTime) / 1000;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `Tavily API 返回错误 (${response.status})`;
        try {
          const err = JSON.parse(errorBody) as { detail?: { error?: string } };
          if (err.detail?.error) errorMsg += `：${err.detail.error}`;
        } catch {
          if (errorBody) errorMsg += `：${errorBody}`;
        }
        throw new Error(errorMsg);
      }

      const data = (await response.json()) as {
        query?: string;
        results?: Array<{ title?: string; url?: string; content?: string; score?: number; raw_content?: string | null }>;
        answer?: string | null;
        usage?: { credits?: number | null };
      };

      return {
        query: data.query ?? params.query,
        results: (data.results ?? []).map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          content: r.content ?? '',
          score: r.score ?? 0,
          raw_content: r.raw_content ?? null,
        })),
        answer: data.answer ?? null,
        response_time: responseTime,
        credits_used: data.usage?.credits ?? null,
      };
    },
  };
}
