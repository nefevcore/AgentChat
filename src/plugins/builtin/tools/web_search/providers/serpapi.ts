// ============================================================
// SerpAPI Search Provider
//
// SerpAPI 提供 Google、Bing 等搜索引擎的结构化结果。
// 文档：https://serpapi.com/search-api
// 每月 100 次免费搜索（https://serpapi.com/playground）
// ============================================================

import type { SearchProvider, SearchParams, SearchResponse, ProviderConfig } from '../types';

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

      // 构建 SerpAPI 查询参数（GET 请求，全部走 query string）
      const queryParams = new URLSearchParams();
      queryParams.set('api_key', apiKey);
      queryParams.set('q', params.query);
      queryParams.set('engine', 'google');
      queryParams.set('num', String(params.max_results ?? 5));
      queryParams.set('hl', 'zh-CN');
      queryParams.set('gl', 'cn');

      // SerpAPI 不支持 search_depth，但支持 tbs 时间过滤
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

      // 域名过滤（SerpAPI 不支持 include_domains/exclude_domains 直接参数，
      // 但可以通过 site: 或 -site: 语法拼接到 query 中）
      // 这里仅对少量域名做简单拼接（生产环境可扩展）
      if (params.include_domains?.length) {
        const siteFilters = params.include_domains.map(d => `site:${d}`).join(' OR ');
        queryParams.set('q', `${siteFilters} ${params.query}`);
      }

      // 新闻搜索使用 Google News engine
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

      // 标准化结果
      const organic = data.organic_results ?? [];
      const results = organic.map((r: any, idx: number) => ({
        title: r.title ?? '',
        url: r.link ?? '',
        content: r.snippet ?? '',
        score: 1 - idx / Math.max(organic.length, 1), // 按排名归一化
      }));

      // 如果有知识图谱/答案框，拼接到 answer
      const answer = data.answer_box?.answer
        ?? data.answer_box?.snippet
        ?? data.knowledge_graph?.description
        ?? null;

      return {
        query: params.query,
        results,
        answer,
        response_time: responseTime,
        credits_used: null, // SerpAPI 不返回 credits 信息
      };
    },

    configuration: [],
  };
}
