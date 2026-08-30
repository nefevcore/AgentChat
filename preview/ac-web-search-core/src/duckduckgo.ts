// ============================================================
// ac-web-search-core/src/duckduckgo.ts —— DuckDuckGo Instant Answer
// Provider（src 原样平移；免费无需 Key，测试/冷启动友好）
// ============================================================
import type { ProviderConfig, SearchParams, SearchProvider, SearchResponse, SearchResult } from './types.ts';

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
      const queryParams = new URLSearchParams();
      queryParams.set('q', params.query);
      queryParams.set('format', 'json');
      queryParams.set('no_html', '1');
      queryParams.set('skip_disambig', '1');

      const startTime = Date.now();
      const response = await fetch(`${DDG_API_URL}?${queryParams.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const responseTime = (Date.now() - startTime) / 1000;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`DuckDuckGo API 返回错误 (${response.status})：${errorBody}`);
      }

      const data = (await response.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        Answer?: string;
        Heading?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Infobox?: { content?: Array<{ label?: string; value?: string; data_type?: string }> };
      };

      const results: SearchResult[] = [];
      const maxResults = params.max_results ?? 5;

      if (data.AbstractText && data.AbstractURL) {
        results.push({
          title: data.Heading ?? params.query,
          url: data.AbstractURL,
          content: data.AbstractText,
          score: 1.0,
        });
      }

      if (data.Answer && data.Answer !== data.AbstractText) {
        results.push({
          title: `${params.query} - 答案`,
          url: data.AbstractURL ?? `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
          content: data.Answer,
          score: 0.9,
        });
      }

      const topics = data.RelatedTopics ?? [];
      for (let i = 0; i < Math.min(topics.length, maxResults - results.length); i++) {
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

      if (data.Infobox?.content && results.length < maxResults) {
        for (const entry of data.Infobox.content.slice(0, maxResults - results.length)) {
          results.push({
            title: entry.label ?? entry.data_type ?? '',
            url: `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
            content: `${entry.label ?? ''}: ${entry.value ?? ''}`,
            score: 0.5,
          });
        }
      }

      if (results.length === 0) {
        results.push({
          title: `在 DuckDuckGo 中搜索 "${params.query}"`,
          url: `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
          content: '未找到直接答案，请点击链接在 DuckDuckGo 中查看完整结果。',
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
  };
}
