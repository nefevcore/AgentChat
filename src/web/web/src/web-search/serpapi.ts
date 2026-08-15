// ============================================================
// SerpAPI Search Provider（照搬旧 mod tools/web_search/providers/serpapi）
// ============================================================

import type { SearchProvider, SearchParams, SearchResponse, ProviderConfig } from './types';

const SERPAPI_SEARCH_URL = 'https://serpapi.com/search';

export function createSerpApiProvider(): SearchProvider {
  return {
    id: 'serpapi',
    label: 'SerpAPI',
    description: 'Google/Bing 等主流搜索引擎的结构化结果',

    validateConfig(cfg: ProviderConfig): void {
      if (!cfg.apiKey) {
        throw new Error(
          '未配置 SerpAPI 密钥。请在池条目的 API 密钥字段中设置。' +
          '可前往 https://serpapi.com 免费注册（每月 100 次免费搜索）。'
        );
      }
    },

    async search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse> {
      const apiKey = cfg.apiKey;

      const queryParams = new URLSearchParams();
      queryParams.set('api_key', apiKey);
      queryParams.set('q', params.query);
      queryParams.set('engine', 'google');
      queryParams.set('num', String(params.max_results ?? 5));
      queryParams.set('hl', 'zh-CN');
      queryParams.set('gl', 'cn');

      if (params.time_range) {
        const tbsMap: Record<string, string> = {
          'day': 'qdr:d', 'd': 'qdr:d',
          'week': 'qdr:w', 'w': 'qdr:w',
          'month': 'qdr:m', 'm': 'qdr:m',
          'year': 'qdr:y', 'y': 'qdr:y',
        };
        const tbs = tbsMap[params.time_range];
        if (tbs) queryParams.set('tbs', tbs);
      }

      if (params.include_domains?.length) {
        const siteFilters = params.include_domains.map(d => `site:${d}`).join(' OR ');
        queryParams.set('q', `${siteFilters} ${params.query}`);
      }

      if (params.topic === 'news') {
        queryParams.set('engine', 'google_news');
      }

      const startTime = Date.now();
      const response = await fetch(`${SERPAPI_SEARCH_URL}?${queryParams.toString()}`);
      const responseTime = (Date.now() - startTime) / 1000;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`SerpAPI 返回错误 (${response.status})：${errorBody}`);
      }

      const data = await response.json() as any;

      const organic = data.organic_results ?? [];
      const results = organic.map((r: any, idx: number) => ({
        title: r.title ?? '',
        url: r.link ?? '',
        content: r.snippet ?? '',
        score: 1 - idx / Math.max(organic.length, 1),
      }));

      const answer = data.answer_box?.answer
        ?? data.answer_box?.snippet
        ?? data.knowledge_graph?.description
        ?? null;

      return {
        query: params.query,
        results,
        answer,
        response_time: responseTime,
        credits_used: null,
      };
    },

    configuration: [],
  };
}
