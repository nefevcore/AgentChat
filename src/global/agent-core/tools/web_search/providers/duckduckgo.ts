// ============================================================
// DuckDuckGo Instant Answer API Provider
//
// DuckDuckGo 提供免费的零配置搜索（无需 API Key）。
// 文档：https://duckduckgo.com/api
// 完全免费，无速率限制说明，适合开发/轻量使用。
//
// 注意：DuckDuckGo Instant Answer API 返回结果较简洁，
// 不包含传统搜索引擎的排名列表。如需更丰富结果请使用 Tavily/SerpAPI。
// ============================================================

import type { SearchProvider, SearchParams, SearchResponse, ProviderConfig } from '../types';

const DDG_API_URL = 'https://api.duckduckgo.com';

export function createDuckDuckGoProvider(): SearchProvider {
  return {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    description: '免费即时答案 API，无需 API Key，隐私友好',

    validateConfig(_cfg: ProviderConfig): void {
      // DuckDuckGo 无需 API Key，永远通过校验
    },

    async search(params: SearchParams, _cfg: ProviderConfig): Promise<SearchResponse> {
      // DuckDuckGo Instant Answer API 参数
      const queryParams = new URLSearchParams();
      queryParams.set('q', params.query);
      queryParams.set('format', 'json');
      queryParams.set('no_html', '1');
      queryParams.set('skip_disambig', '1');

      const startTime = Date.now();

      // DuckDuckGo 只支持 GET
      const response = await fetch(`${DDG_API_URL}?${queryParams.toString()}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      const responseTime = (Date.now() - startTime) / 1000;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`DuckDuckGo API 返回错误 (${response.status})：${errorBody}`);
      }

      const data = await response.json() as any;

      // 构建结果列表
      const results: Array<{ title: string; url: string; content: string; score: number }> = [];

      // 1. 抽象/摘要（Abstract）
      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading ?? params.query,
          url: data.AbstractURL,
          content: data.AbstractText,
          score: 1.0,
        });
      }

      // 2. 答案（Answer）
      if (data.Answer && data.Answer !== data.AbstractText) {
        results.push({
          title: `${params.query} - 答案`,
          url: data.AbstractURL ?? `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
          content: data.Answer,
          score: 0.9,
        });
      }

      // 3. 相关话题（RelatedTopics）
      const topics = data.RelatedTopics ?? [];
      for (let i = 0; i < Math.min(topics.length, (params.max_results ?? 5) - results.length); i++) {
        const t = topics[i];
        if (t.Text && t.FirstURL) {
          results.push({
            title: t.Text.split(' - ')[0] ?? t.Text.substring(0, 60),
            url: t.FirstURL,
            content: t.Text,
            score: Math.max(0.8 - i * 0.1, 0.1),
          });
        }
      }

      // 4. 信息框（Infobox）
      if (data.Infobox?.content && results.length < (params.max_results ?? 5)) {
        for (const entry of data.Infobox.content.slice(0, (params.max_results ?? 5) - results.length)) {
          results.push({
            title: entry.label ?? entry.data_type ?? '',
            url: `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
            content: `${entry.label ?? ''}: ${entry.value ?? ''}`,
            score: 0.5,
          });
        }
      }

      // 如果没有搜到任何结果，返回兜底
      if (results.length === 0) {
        results.push({
          title: `在 DuckDuckGo 中搜索 "${params.query}"`,
          url: `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
          content: `未找到直接答案，请点击链接在 DuckDuckGo 中查看完整结果。`,
          score: 1.0,
        });
      }

      return {
        query: params.query,
        results,
        answer: data.AbstractText ?? data.Answer ?? null,
        response_time: responseTime,
        credits_used: null,
      };
    },

    configuration: [] as ConfigField[],
  };
}
