// ============================================================
// ac-web-search-core：provider 注册表 / 五工厂请求与响应归一化行为锁定（打桩 fetch，零真实网络）
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PROVIDER_REGISTRY,
  createTavilyProvider,
  createSerpApiProvider,
  createBraveProvider,
  createDuckDuckGoProvider,
  createDeepSeekProvider,
  parseSourceSummaries,
  extractAnswer,
  mapAnthropicResponse,
} from '../src/index.ts';

/** providers 调全局 fetch 的最小形状（不可注入，统一 vi.stubGlobal 打桩） */
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PROVIDER_REGISTRY', () => {
  it('2026-10 收敛：恰好含 tavily/deepseek 两个键（serpapi/brave/duckduckgo 不在表）', () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual(['deepseek', 'tavily']);
    expect(PROVIDER_REGISTRY).not.toHaveProperty('serpapi');
    expect(PROVIDER_REGISTRY).not.toHaveProperty('brave');
    expect(PROVIDER_REGISTRY).not.toHaveProperty('duckduckgo');
  });

  it('每键是可调用工厂，产出带 id/label/方法 的 provider 实例', () => {
    for (const [name, factory] of Object.entries(PROVIDER_REGISTRY)) {
      expect(factory).toBeTypeOf('function');
      const p = factory();
      expect(p.id).toBe(name);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(typeof p.validateConfig).toBe('function');
      expect(typeof p.search).toBe('function');
    }
  });
});

describe('createTavilyProvider', () => {
  const provider = createTavilyProvider();

  it('validateConfig：空 apiKey 抛错（含获取指引），有 key 通过', () => {
    expect(() => provider.validateConfig({ apiKey: '' })).toThrow(/Tavily API 密钥/);
    expect(() => provider.validateConfig({ apiKey: '' })).toThrow(/app\.tavily\.com/);
    expect(() => provider.validateConfig({ apiKey: 'tvly-x' })).not.toThrow();
  });

  it('search：缺省请求形状（URL/鉴权头/body 缺省值）与响应归一化（缺字段兜空、credits 取 usage）', async () => {
    const data = {
      results: [
        { title: '完整项', url: 'https://full', content: '内容', score: 0.7, raw_content: '原文' },
        { url: 'https://partial' }, // 缺 title/content/score/raw_content → 兜底
      ],
      usage: { credits: 42 },
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await provider.search({ query: 'AgentChat' }, { apiKey: 'tvly-key' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.tavily.com/search');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer tvly-key');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      query: 'AgentChat',
      search_depth: 'advanced', // 缺省非 basic → advanced
      max_results: 5,
      topic: 'general',
    });
    // 可选参数未传时不出现在 body
    expect(body).not.toHaveProperty('include_domains');
    expect(body).not.toHaveProperty('exclude_domains');
    expect(body).not.toHaveProperty('time_range');
    expect(body).not.toHaveProperty('include_answer');
    expect(body).not.toHaveProperty('include_raw_content');

    expect(res.query).toBe('AgentChat'); // 响应缺 query → 回填请求 query
    expect(res.results).toEqual([
      { title: '完整项', url: 'https://full', content: '内容', score: 0.7, raw_content: '原文' },
      { title: '', url: 'https://partial', content: '', score: 0, raw_content: null },
    ]);
    expect(res.answer).toBeNull();
    expect(res.credits_used).toBe(42);
    expect(typeof res.response_time).toBe('number');
    expect(res.response_time).toBeGreaterThanOrEqual(0);
  });

  it('search：参数透传（basic/条数/域名过滤/时间窗/include_answer 映射）与响应侧 query/answer 优先', async () => {
    const data = { query: '响应侧 query', answer: '直接答案', results: [] };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await provider.search(
      {
        query: 'Q',
        search_depth: 'basic',
        max_results: 8,
        include_domains: ['a.com'],
        exclude_domains: ['b.com'],
        time_range: 'week',
        include_answer: true,
        include_raw_content: false,
      },
      { apiKey: 'k' },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      query: 'Q',
      search_depth: 'basic',
      max_results: 8,
      include_domains: ['a.com'],
      exclude_domains: ['b.com'],
      time_range: 'week',
      include_answer: 'advanced', // true → 'advanced'
      include_raw_content: false,
    });
    expect(res.query).toBe('响应侧 query'); // 响应带 query → 优先
    expect(res.answer).toBe('直接答案');
    expect(res.results).toEqual([]);
  });

  it('search：非 ok 且 body 为 JSON → detail.error 拼进错误消息', async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ detail: { error: 'Invalid API key' } }), { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(provider.search({ query: 'q' }, { apiKey: 'bad' })).rejects.toThrow(
      /Tavily API 返回错误 \(429\)：Invalid API key/,
    );
  });

  it('search：ok=false 且 body 非 JSON → 容错拼接原文', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response('Bad Gateway 网关故障', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(provider.search({ query: 'q' }, { apiKey: 'k' })).rejects.toThrow(
      /Tavily API 返回错误 \(502\)：Bad Gateway 网关故障/,
    );
  });
});

describe('createDeepSeekProvider 纯函数', () => {
  it('parseSourceSummaries：SOURCE:/SUMMARY: 配对，续行拼接（空行忽略），前导散文与 ANSWER: 段忽略', () => {
    const text = [
      '下面是搜索结果：', // 前导散文
      'SOURCE: https://a.com',
      'SUMMARY: 第一行',
      '第二行续写',
      '',
      'SOURCE: https://b.com',
      'SUMMARY: b 摘要',
      'ANSWER: 综合结论',
      'ANSWER 之后的行也被忽略',
    ].join('\n');
    const map = parseSourceSummaries(text);
    expect(map.size).toBe(2);
    expect(map.get('https://a.com')).toBe('第一行\n第二行续写');
    expect(map.get('https://b.com')).toBe('b 摘要');
  });

  it('parseSourceSummaries：同 URL 首个优先', () => {
    const map = parseSourceSummaries(
      'SOURCE: https://dup.com\nSUMMARY: 首个\nSOURCE: https://dup.com\nSUMMARY: 第二个',
    );
    expect(map.get('https://dup.com')).toBe('首个');
  });

  it('parseSourceSummaries：空文本 / 无标记文本 → 空 Map', () => {
    expect(parseSourceSummaries('').size).toBe(0);
    expect(parseSourceSummaries('没有任何结构化标记的散文').size).toBe(0);
  });

  it('extractAnswer：取最后一次 ANSWER: 标记之后的内容并 trim', () => {
    expect(extractAnswer(['SOURCE: https://a.com\nSUMMARY: 摘要', 'ANSWER: 是 42'])).toBe('是 42');
    expect(extractAnswer(['ANSWER: 第一版', 'ANSWER: 第二版'])).toBe('第二版');
  });

  it('extractAnswer：ANSWER 段截到下一个 SOURCE: 为止', () => {
    expect(extractAnswer(['ANSWER: 甲\nSOURCE: https://x.com\nSUMMARY: 乙'])).toBe('甲');
  });

  it('extractAnswer：无 ANSWER: 标记 → 回落最后一个非空 text 块；全空 → null', () => {
    expect(extractAnswer(['', '散文综合段', '   '])).toBe('散文综合段');
    expect(extractAnswer([''])).toBeNull();
    expect(extractAnswer([])).toBeNull();
  });

  it('mapAnthropicResponse：无 web_search_tool_result 块 → 抛错（不退化解析散文）', () => {
    expect(() => mapAnthropicResponse({ content: [{ type: 'text', text: 'hi' }] }, 5)).toThrow(
      /web_search_tool_result/,
    );
    expect(() => mapAnthropicResponse(undefined, 5)).toThrow(/web_search_tool_result/);
  });

  it('mapAnthropicResponse：citations 优先、SUMMARY 兜底、title 缺省回退 URL、按 URL 去重、maxResults 截断', () => {
    const data = {
      content: [
        { type: 'text', text: '模型前言' },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://a.com', title: 'A 页', page_age: '2025-01-01' },
            { type: 'web_search_result', url: 'https://b.com' }, // 缺 title/page_age
            { type: 'web_search_result', url: 'https://a.com' }, // 重复 URL
            { type: 'web_search_result', url: 'https://c.com', title: 'C 页' },
            { type: 'other_kind', url: 'https://x.com' }, // 非 web_search_result 项
          ],
        },
        {
          type: 'text',
          text: 'SOURCE: https://b.com\nSUMMARY: B 摘要\n续行',
          citations: [{ url: 'https://a.com', cited_text: 'A 引用片段' }], // citations 优先于 SUMMARY
        },
      ],
    };
    const sources = mapAnthropicResponse(data, 5);
    expect(sources).toEqual([
      { title: 'A 页', url: 'https://a.com', snippet: 'A 引用片段', publishedAt: '2025-01-01' },
      { title: 'https://b.com', url: 'https://b.com', snippet: 'B 摘要\n续行' },
      { title: 'C 页', url: 'https://c.com', snippet: '' },
    ]);
    // maxResults 本地截断（API 无结果条数参数）
    const clipped = mapAnthropicResponse(data, 2);
    expect(clipped).toHaveLength(2);
    expect(clipped[1]?.url).toBe('https://b.com');
  });
});

describe('createDeepSeekProvider search', () => {
  const provider = createDeepSeekProvider();

  it('validateConfig：空 key 抛错（含获取指引），有 key 通过', () => {
    expect(() => provider.validateConfig({ apiKey: '' })).toThrow(/DeepSeek API 密钥/);
    expect(() => provider.validateConfig({ apiKey: '' })).toThrow(/platform\.deepseek\.com/);
    expect(() => provider.validateConfig({ apiKey: 'sk-x' })).not.toThrow();
  });

  it('请求打到缺省 {baseURL}/messages，头/请求体按约定，响应归一化（publishedAt 前缀、名次递减 score）', async () => {
    const data = {
      content: [
        { type: 'text', text: 'SOURCE: https://a.com\nSUMMARY: A 摘要' },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://a.com', title: 'A 页', page_age: '2025-06-01' },
            { type: 'web_search_result', url: 'https://b.com', title: 'B 页' }, // 无摘要无时间 → content 空
          ],
        },
        { type: 'text', text: 'ANSWER: 综合答案' },
      ],
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await provider.search({ query: '测试查询' }, { apiKey: 'sk-x' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-x');
    expect(headers.Authorization).toBe('Bearer sk-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].text).toContain('测试查询');
    expect(body.tools[0]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });

    expect(res.query).toBe('测试查询');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({
      title: 'A 页',
      url: 'https://a.com',
      content: '[2025-06-01] A 摘要',
      raw_content: null,
    });
    expect(res.results[0]?.score).toBeCloseTo(0.9);
    expect(res.results[1]).toMatchObject({ title: 'B 页', url: 'https://b.com', content: '', raw_content: null });
    expect(res.results[1]?.score).toBeCloseTo(0.8);
    expect(res.answer).toBe('综合答案');
    expect(typeof res.response_time).toBe('number');
    expect(res.credits_used).toBeNull();
  });

  it('baseURL/model/maxTokens/maxUses/apiVersion 覆盖透传（端点换成 {baseURL}/messages）', async () => {
    const data = {
      content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com' }] }],
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await provider.search(
      { query: 'q' },
      {
        apiKey: 'k',
        baseURL: 'https://gw.example/anthropic',
        model: 'm-x',
        maxUses: 2,
        maxTokens: 128,
        apiVersion: '2024-01-01',
      },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gw.example/anthropic/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2024-01-01');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('m-x');
    expect(body.max_tokens).toBe(128);
    expect(body.tools[0].max_uses).toBe(2);
    expect(res.results).toHaveLength(1);
  });

  it('非 ok 响应：error.message 解析拼进错误消息', async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(provider.search({ query: 'q' }, { apiKey: 'bad' })).rejects.toThrow(
      /DeepSeek API 返回错误 \(401\)：Authentication Fails/,
    );
  });
});

describe('未入注册表的三家工厂（个体导出保留）', () => {
  it('serpapi：id/label 非空；空 key 抛错（含指引），有 key 通过', () => {
    const p = createSerpApiProvider();
    expect(p.id).toBe('serpapi');
    expect(p.label).toBe('SerpAPI');
    expect(() => p.validateConfig({ apiKey: '' })).toThrow(/serpapi\.com/);
    expect(() => p.validateConfig({ apiKey: 'k' })).not.toThrow();
  });

  it('brave：id/label 非空；空 key 抛错（含指引），有 key 通过', () => {
    const p = createBraveProvider();
    expect(p.id).toBe('brave');
    expect(p.label).toBe('Brave Search');
    expect(() => p.validateConfig({ apiKey: '' })).toThrow(/brave\.com\/search\/api/);
    expect(() => p.validateConfig({ apiKey: 'k' })).not.toThrow();
  });

  it('duckduckgo：免费无 Key——空 key 也不抛错；id/label 非空', () => {
    const p = createDuckDuckGoProvider();
    expect(p.id).toBe('duckduckgo');
    expect(p.label).toBe('DuckDuckGo');
    expect(() => p.validateConfig({ apiKey: '' })).not.toThrow();
  });

  it('serpapi search：query 参数拼装 + organic_results 归一化 + answer_box 回填', async () => {
    const data = {
      organic_results: [
        { title: 'T1', link: 'https://1.example', snippet: 'S1' },
        { title: 'T2', link: 'https://2.example' }, // 缺 snippet → 兜空串
      ],
      answer_box: { answer: '框答案' },
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await createSerpApiProvider().search({ query: 'vitest', max_results: 3 }, { apiKey: 'serp-key' });

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe('https://serpapi.com/search');
    expect(parsed.searchParams.get('api_key')).toBe('serp-key');
    expect(parsed.searchParams.get('q')).toBe('vitest');
    expect(parsed.searchParams.get('engine')).toBe('google');
    expect(parsed.searchParams.get('num')).toBe('3');

    expect(res.query).toBe('vitest');
    expect(res.results).toEqual([
      { title: 'T1', url: 'https://1.example', content: 'S1', score: 1 },
      { title: 'T2', url: 'https://2.example', content: '', score: 0.5 },
    ]);
    expect(res.answer).toBe('框答案');
    expect(res.credits_used).toBeNull();
  });

  it('brave search：X-Subscription-Token 头 + count 上限 20 + extra_snippets 仅在 include_raw_content 时透传', async () => {
    const data = {
      web: {
        results: [
          { title: 'B1', url: 'https://b1.example', description: 'D1', extra_snippets: ['x', 'y'] },
          { title: 'B2', url: 'https://b2.example' }, // 缺 description → 兜空串
        ],
      },
      discussions: [{ snippet: '讨论摘要' }],
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await createBraveProvider().search(
      { query: '隐私搜索', max_results: 30, search_depth: 'advanced', include_raw_content: true },
      { apiKey: 'brave-key' },
    );

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(parsed.searchParams.get('q')).toBe('隐私搜索');
    expect(parsed.searchParams.get('count')).toBe('20'); // min(30, 20)
    expect(parsed.searchParams.get('extra_snippets')).toBe('true');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('brave-key');

    expect(res.query).toBe('隐私搜索');
    expect(res.results).toEqual([
      { title: 'B1', url: 'https://b1.example', content: 'D1', score: 1, raw_content: 'x\ny' },
      { title: 'B2', url: 'https://b2.example', content: '', score: 0.5, raw_content: null },
    ]);
    expect(res.answer).toBe('讨论摘要');
  });

  it('duckduckgo search：abstract/answer/related topics 合成结果，max_results 截断', async () => {
    const data = {
      Heading: 'AgentChat',
      AbstractText: 'AgentChat 是一个平台',
      AbstractURL: 'https://a.example/abs',
      Answer: '42',
      RelatedTopics: [
        { Text: 'Topic One - 更多说明', FirstURL: 'https://t1.example' },
        { Text: 'Topic Two - 说明', FirstURL: 'https://t2.example' },
        { Text: 'Topic Three', FirstURL: 'https://t3.example' },
      ],
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await createDuckDuckGoProvider().search({ query: 'AgentChat', max_results: 3 }, { apiKey: '' });

    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.origin).toBe('https://api.duckduckgo.com');
    expect(parsed.searchParams.get('q')).toBe('AgentChat');
    expect(parsed.searchParams.get('format')).toBe('json');
    expect(parsed.searchParams.get('no_html')).toBe('1');
    expect(parsed.searchParams.get('skip_disambig')).toBe('1');

    // 预算 3：abstract(1.0) + answer(0.9) + 首个 related topic(0.8)
    expect(res.answer).toBe('AgentChat 是一个平台');
    expect(res.results).toEqual([
      { title: 'AgentChat', url: 'https://a.example/abs', content: 'AgentChat 是一个平台', score: 1.0 },
      { title: 'AgentChat - 答案', url: 'https://a.example/abs', content: '42', score: 0.9 },
      { title: 'Topic One', url: 'https://t1.example', content: 'Topic One - 更多说明', score: 0.8 },
    ]);
  });

  it('duckduckgo search：无任何结果字段 → 兜底提示项', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const res = await createDuckDuckGoProvider().search({ query: '冷门词' }, { apiKey: '' });

    expect(res.answer).toBeNull();
    expect(res.results).toEqual([
      {
        title: '在 DuckDuckGo 中搜索 "冷门词"',
        url: 'https://duckduckgo.com/?q=%E5%86%B7%E9%97%A8%E8%AF%8D',
        content: '未找到直接答案，请点击链接在 DuckDuckGo 中查看完整结果。',
        score: 1.0,
      },
    ]);
  });
});
