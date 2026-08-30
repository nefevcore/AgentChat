// ============================================================
// DeepSeek 搜索 Provider 单测
// 覆盖：Anthropic 响应映射（严格模式/去重/snippet 回填/截断）、
//       结构化 SOURCE:/SUMMARY:/ANSWER: 解析、请求体形状、HTTP 错误解析
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createDeepSeekProvider,
  mapAnthropicResponse,
  parseSourceSummaries,
  extractAnswer,
} from '../src/web-search/deepseek';
import type { ProviderConfig } from '../src/web-search/types';

const CFG: ProviderConfig = { apiKey: 'sk-test' };

/** 构造一条 Anthropic Messages 形状的响应 */
function anthropicResponse(blocks: any[]): any {
  return { id: 'msg_1', type: 'message', role: 'assistant', content: blocks };
}

function searchResultBlock(items: any[]): any {
  return { type: 'web_search_tool_result', tool_use_id: 'tu_1', content: items };
}

function textBlock(text: string, citations: any[] = []): any {
  return { type: 'text', text, ...(citations.length ? { citations } : {}) };
}

const ITEM_A = { type: 'web_search_result', url: 'https://a.example/1', title: 'Result A', page_age: '2025-01-01' };
const ITEM_B = { type: 'web_search_result', url: 'https://b.example/2', title: 'Result B', page_age: null };
const ITEM_NODATE = { type: 'web_search_result', url: 'https://c.example/3', title: null, page_age: null };

/** 实测形态的模型结构化输出（中文摘要 + ANSWER 综合段） */
const STRUCTURED_TEXT = [
  '以下是搜索结果整理：',
  'SOURCE: https://a.example/1',
  'SUMMARY: 报道了 A 页面的核心内容：价格于 8 月 17 日调整，',
  '高峰时段输入 3 元/百万 tokens。',
  'SOURCE: https://b.example/2',
  'SUMMARY: B 页面列出了完整价格方案与历史变化。',
  'ANSWER: 综合来看，价格先降后涨，8 月起引入峰谷定价。',
].join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── parseSourceSummaries ──

describe('parseSourceSummaries', () => {
  it('解析 SOURCE/SUMMARY 对；SUMMARY 续行归并；前导散文忽略', () => {
    const map = parseSourceSummaries(STRUCTURED_TEXT);
    expect(map.get('https://a.example/1')).toBe('报道了 A 页面的核心内容：价格于 8 月 17 日调整，\n高峰时段输入 3 元/百万 tokens。');
    expect(map.get('https://b.example/2')).toBe('B 页面列出了完整价格方案与历史变化。');
    expect(map.size).toBe(2);
  });

  it('首个出现优先；ANSWER 段不产生条目；解析失败返回空映射', () => {
    const dup = parseSourceSummaries('SOURCE: https://x/1\nSUMMARY: first\nSOURCE: https://x/1\nSUMMARY: second\nANSWER: done');
    expect(dup.get('https://x/1')).toBe('first');
    expect(parseSourceSummaries('no markers at all').size).toBe(0);
  });
});

// ── extractAnswer ──

describe('extractAnswer', () => {
  it('提取最后一个 ANSWER: 段', () => {
    expect(extractAnswer([STRUCTURED_TEXT])).toBe('综合来看，价格先降后涨，8 月起引入峰谷定价。');
  });

  it('无标记时回落最后一个非空 text 块；全无返回 null', () => {
    expect(extractAnswer(['first prose', 'final prose'])).toBe('final prose');
    expect(extractAnswer(['', ''])).toBeNull();
  });

  it('ANSWER 后若混入 SOURCE 行则截断', () => {
    expect(extractAnswer(['ANSWER: ok\nSOURCE: https://x/1\nSUMMARY: stray'])).toBe('ok');
  });
});

// ── mapAnthropicResponse ──

describe('mapAnthropicResponse', () => {
  it('snippet 优先取 citations（DSH 原路径，DeepSeek 暂不返回时让位 SUMMARY）', () => {
    const data = anthropicResponse([
      textBlock('prose', [{ url: 'https://a.example/1', cited_text: 'cited excerpt A' }]),
      searchResultBlock([ITEM_A, ITEM_B]),
    ]);
    const sources = mapAnthropicResponse(data, 5);
    expect(sources[0].snippet).toBe('cited excerpt A');
    expect(sources[1].snippet).toBe('');
  });

  it('实测形态：text 无 citations，snippet 从结构化 SUMMARY 解析回填', () => {
    const data = anthropicResponse([
      textBlock(STRUCTURED_TEXT),
      searchResultBlock([ITEM_A, ITEM_B, ITEM_NODATE]),
    ]);
    const sources = mapAnthropicResponse(data, 5);
    expect(sources[0]).toMatchObject({ url: 'https://a.example/1', snippet: expect.stringContaining('价格于 8 月 17 日调整'), publishedAt: '2025-01-01' });
    expect(sources[1]).toMatchObject({ url: 'https://b.example/2', snippet: expect.stringContaining('完整价格方案') });
    // 无 SUMMARY 匹配且无日期 → 空 snippet；title 缺省回落 url
    expect(sources[2]).toEqual({ title: 'https://c.example/3', url: 'https://c.example/3', snippet: '' });
  });

  it('严格模式：无 web_search_tool_result 块时 throw（不退化解析散文）', () => {
    const data = anthropicResponse([textBlock(STRUCTURED_TEXT)]);
    expect(() => mapAnthropicResponse(data, 5)).toThrow(/web_search_tool_result/);
  });

  it('按 url 去重（跨多个结果块）', () => {
    const data = anthropicResponse([
      searchResultBlock([ITEM_A, ITEM_B]),
      searchResultBlock([{ ...ITEM_A, title: 'dup of A' }, ITEM_NODATE]),
    ]);
    const sources = mapAnthropicResponse(data, 10);
    expect(sources.map((s) => s.url)).toEqual([
      'https://a.example/1', 'https://b.example/2', 'https://c.example/3',
    ]);
  });

  it('超出 maxResults 本地截断（API 无条数参数）', () => {
    const data = anthropicResponse([searchResultBlock([ITEM_A, ITEM_B, ITEM_NODATE])]);
    expect(mapAnthropicResponse(data, 2)).toHaveLength(2);
  });

  it('跳过空 url 与非 web_search_result 项', () => {
    const data = anthropicResponse([
      searchResultBlock([
        { type: 'web_search_result', url: '', title: 'empty url' },
        { type: 'other', url: 'https://x.example' },
        ITEM_A,
      ]),
    ]);
    const sources = mapAnthropicResponse(data, 5);
    expect(sources.map((s) => s.url)).toEqual(['https://a.example/1']);
  });
});

// ── SearchProvider 契约 ──

describe('createDeepSeekProvider', () => {
  const provider = createDeepSeekProvider();

  it('元数据：id/label 非空', () => {
    expect(provider.id).toBe('deepseek');
    expect(provider.label).toBeTruthy();
  });

  it('validateConfig：缺 key 时 throw 并给出获取指引', () => {
    expect(() => provider.validateConfig({ apiKey: '' })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => provider.validateConfig({ apiKey: 'sk-x' })).not.toThrow();
  });

  it('search：请求体携带 web_search 工具与结构化指令；content/answer 来自 SUMMARY/ANSWER', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(anthropicResponse([
        textBlock(STRUCTURED_TEXT),
        searchResultBlock([ITEM_A, ITEM_B]),
      ])), { status: 200 });
    });

    const out = await provider.search({ query: 'hello 世界', max_results: 5 }, CFG);

    // 请求形状（DSH 对齐 + 结构化指令）
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('sk-test');
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].init.redirect).toBe('error');
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[0].content[0].text).toContain('Perform a web search for the query: hello 世界');
    expect(body.messages[0].content[0].text).toContain('SOURCE:');
    expect(body.messages[0].content[0].text).toContain('ANSWER:');
    expect(body.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ]);

    // 响应映射：content 回填摘要、answer 取 ANSWER 段
    expect(out.query).toBe('hello 世界');
    expect(out.answer).toBe('综合来看，价格先降后涨，8 月起引入峰谷定价。');
    expect(out.credits_used).toBeNull();
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ title: 'Result A', url: 'https://a.example/1', score: 0.9 });
    expect(out.results[0].content).toContain('价格于 8 月 17 日调整');
    expect(out.results[1]).toMatchObject({ url: 'https://b.example/2', score: 0.8 });
  });

  it('search：扩展字段（baseURL/model/maxUses/maxTokens）透传到请求', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(anthropicResponse([searchResultBlock([ITEM_A])])), { status: 200 });
    });

    await provider.search({ query: 'q' }, {
      apiKey: 'sk-test',
      baseURL: 'https://gw.internal/anthropic/v1',
      model: 'deepseek-v4',
      maxUses: 3,
      maxTokens: 1024,
    });

    expect(calls[0].url).toBe('https://gw.internal/anthropic/v1/messages');
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe('deepseek-v4');
    expect(body.max_tokens).toBe(1024);
    expect(body.tools[0].max_uses).toBe(3);
  });

  it('search：超长摘要截断到软上限', async () => {
    const longSummary = 'x'.repeat(2000);
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify(anthropicResponse([
        textBlock(`SOURCE: https://a.example/1\nSUMMARY: ${longSummary}`),
        searchResultBlock([ITEM_A]),
      ])), { status: 200 }));
    const out = await provider.search({ query: 'q' }, CFG);
    expect(out.results[0].content.length).toBeLessThanOrEqual(1201); // 1200 + 省略号
  });

  it('search：HTTP 非 2xx 解析 error.message 并抛出', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }));

    await expect(provider.search({ query: 'q' }, CFG)).rejects.toThrow(/401.*invalid api key/);
  });

  it('search：原生搜索未触发（无结果块）时报错', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify(anthropicResponse([textBlock('no search happened')])), { status: 200 }));

    await expect(provider.search({ query: 'q' }, CFG)).rejects.toThrow(/web_search_tool_result/);
  });
});
