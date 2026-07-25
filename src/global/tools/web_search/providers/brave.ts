// ============================================================
// Brave Search API Provider
//
// Brave Search 注重隐私的独立搜索引擎。
// 文档：https://api.search.brave.com/app/documentation/web-search
// 免费额度：每月 2000 次（https://brave.com/search/api/）
// ============================================================

import type { SearchProvider, SearchParams, SearchResponse, ProviderConfig } from '../types';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export function createBraveProvider(): SearchProvider {
  return {
    id: 'brave',
    label: 'Brave Search',
    description: '注重隐私的独立搜索引擎，无追踪',

    validateConfig(cfg: ProviderConfig): void {
      if (!cfg.apiKey) {
        throw new Error(
          '未配置 Brave Search API 密钥。请在池条目的 API 密钥字段中设置。' +
          '可前往 https://brave.com/search/api/ 免费获取（每月 2000 次免费额度）。'
        );
      }
    },

    async search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse> {
      const apiKey = cfg.apiKey;

      // Brave Search 使用 GET + query string + 自定义 header
      const queryParams = new URLSearchParams();
      queryParams.set('q', params.query);
      queryParams.set('count', String(Math.min(params.max_results ?? 5, 20)));

      // Safesearch & 国家
      queryParams.set('country', 'CN');
      queryParams.set('search_lang', 'zh');

      // 时间范围
      if (params.time_range) {
        const freshMap: Record<string, string> = {
          'day': 'pd', 'd': 'pd',
          'week': 'pw', 'w': 'pw',
          'month': 'pm', 'm': 'pm',
          'year': 'py', 'y': 'py',
        };
        const fresh = freshMap[params.time_range];
        if (fresh) queryParams.set('freshness', fresh);
      }

      // 结果深度：advanced → extra_snippets
      if (params.search_depth === 'advanced') {
        queryParams.set('extra_snippets', 'true');
      }

      // 新闻搜索
      if (params.topic === 'news') {
        queryParams.set('result_filter', 'news');
      }

      const startTime = Date.now();
      const response = await fetch(`${BRAVE_SEARCH_URL}?${queryParams.toString()}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });
      const responseTime = (Date.now() - startTime) / 1000;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`Brave Search API 返回错误 (${response.status})：${errorBody}`);
      }

      const data = await response.json() as any;

      // 标准化结果
      const web = data.web ?? {};
      const rawResults = web.results ?? [];
      const results = rawResults.map((r: any, idx: number) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.description ?? '',
        score: 1 - idx / Math.max(rawResults.length, 1),
        raw_content: params.include_raw_content ? (r.extra_snippets?.join('\n') ?? null) : null,
      }));

      // Brave 不直接返回 AI 摘要，但有 discussions/infobox
      const answer = data.discussions?.[0]?.snippet
        ?? data.infobox?.[0]?.description
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
