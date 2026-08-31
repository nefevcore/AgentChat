// ============================================================
// ac-web-search-core/src/deepseek.ts —— DeepSeek 联网搜索 Provider（src 原样平移）
//
// DeepSeek 无专用检索端点，而是调用其 Anthropic 兼容 Messages API
// （POST {baseURL}/messages）并启用原生 web_search_20250305 服务端工具，
// 从结构化 web_search_tool_result 块解析结果。一次搜索 = 一次完整模型
// 回合（计 token，比纯检索端点慢）。
//
// 端点默认 https://api.deepseek.com/anthropic/v1 —— 与 LLM 聊天用的
// https://api.deepseek.com（OpenAI 兼容层）是两个不同 base，不可复用配置；
// API Key 则与 DeepSeek 模型共用同一个（DEEPSEEK_API_KEY）。
//
// 内容来源（实测 DeepSeek 响应）：web_search_result 项只有 title/url/
// page_age + encrypted_content（密文，仅模型服务端可解）；text 块不带
// citations。因此让模型在搜索后按 SOURCE:/SUMMARY: 结构逐源摘要，并输出
// ANSWER: 综合段——按 URL 解析回填每条结果的 content。citations 回填逻辑
// 保留为首选（若日后 DeepSeek 补齐该字段则优先采用）。
// ============================================================
import type { ProviderConfig, SearchParams, SearchProvider, SearchResponse, SearchResult } from './types.ts';

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01';
const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096;
const DEEPSEEK_DEFAULT_MAX_USES = 5;
/** 单条结果 content 软上限（模型摘要偶发过长时截断） */
const CONTENT_MAX_LEN = 1200;

/** Anthropic Messages 响应内容块（仅声明本 provider 用到的形状） */
interface AnthropicBlock {
  type: string;
  text?: string;
  citations?: Array<{ url?: string; cited_text?: string }>;
  content?: Array<{ type: string; url?: string; title?: string | null; page_age?: string | null }>;
}

/** 标准化后的单条搜索结果（映射中间产物，导出供单测） */
export interface DeepSeekSource {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

/** 结构化指令：搜索完成后逐源摘要 + 综合段（模型服务端可读 encrypted_content） */
function buildSearchInstruction(query: string): string {
  return (
    `Perform a web search for the query: ${query}\n` +
    'After the search tools finish, output one block for EACH source you found, in exactly this format:\n' +
    'SOURCE: <the source url>\n' +
    'SUMMARY: <2-3 sentence summary, in the same language as the query, of what this page says that is relevant to the query>\n\n' +
    'Then end with a single line:\n' +
    'ANSWER: <one-paragraph synthesis of the findings>'
  );
}

/**
 * 解析模型结构化输出：SOURCE:/SUMMARY: 对 → url → 摘要（首个出现优先）。
 * 逐行状态机：SUMMARY 之后、下一个 SOURCE:/ANSWER: 之前的非空行视为续行；
 * 前导散文与 ANSWER: 段忽略。解析失败自然退化为空映射（content 回落空串）。
 */
export function parseSourceSummaries(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let url: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (url !== null) {
      const summary = buf.join('\n').trim();
      if (summary && !map.has(url)) map.set(url, summary);
    }
    url = null;
    buf = [];
  };
  for (const line of text.split('\n')) {
    const src = line.match(/^SOURCE:[ \t]*(.+)$/);
    if (src) {
      flush();
      url = src[1].trim();
      continue;
    }
    if (/^ANSWER:/.test(line)) {
      flush();
      continue;
    }
    if (url === null) continue; // 前导散文，跳过
    if (/^SUMMARY:[ \t]*/.test(line)) {
      buf.push(line.replace(/^SUMMARY:[ \t]*/, ''));
      continue;
    }
    if (line.trim() !== '') buf.push(line); // 摘要续行（忽略空行）
  }
  flush();
  return map;
}

/**
 * 提取 ANSWER: 综合段（取最后一次出现的行首标记，截到末尾或下一个 SOURCE:）。
 * 无标记时回落最后一个 text 块（模型散文综合，仍优于丢弃）；全无返回 null。
 */
export function extractAnswer(textBlocks: string[]): string | null {
  const all = textBlocks.join('\n');
  const marks = [...all.matchAll(/^ANSWER:[ \t]*/gm)];
  let answer: string | null = null;
  if (marks.length > 0) {
    const last = marks[marks.length - 1];
    let rest = all.slice((last.index ?? 0) + last[0].length);
    const cut = rest.search(/^SOURCE:/m);
    if (cut >= 0) rest = rest.slice(0, cut);
    answer = rest.trim() || null;
  }
  if (answer === null) {
    for (let i = textBlocks.length - 1; i >= 0; i--) {
      const t = textBlocks[i]?.trim();
      if (t) {
        answer = t;
        break;
      }
    }
  }
  return answer;
}

/** 从 text 块的 citations[] 构建 url → cited_text 映射（首个出现优先；DSH 原路径） */
function citationSnippets(blocks: AnthropicBlock[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !map.has(cite.url)) map.set(cite.url, cite.cited_text);
    }
  }
  return map;
}

/**
 * 把 Anthropic Messages 响应映射为标准化来源列表（严格模式）。
 * - 无 web_search_tool_result 块 → throw（原生搜索未触发，绝不退化解析模型散文）
 * - snippet = citations 的 cited_text（若返回）→ 否则结构化 SUMMARY 解析
 * - 按 url 去重（max_uses > 1 时同一页面可能跨多次搜索重复出现）
 * - API 无结果条数参数，按 maxResults 本地截断（DSH 同款）
 */
export function mapAnthropicResponse(
  data: { content?: AnthropicBlock[] } | undefined,
  maxResults: number,
): DeepSeekSource[] {
  const blocks: AnthropicBlock[] = data?.content ?? [];
  const resultBlocks = blocks.filter((b) => b.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new Error('DeepSeek 未返回 web_search_tool_result 块：原生联网搜索可能未被触发');
  }
  const textBlocks = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
  const citations = citationSnippets(blocks);
  const summaries = parseSourceSummaries(textBlocks.join('\n'));

  const seen = new Set<string>();
  const sources: DeepSeekSource[] = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const snippet = citations.get(item.url) ?? summaries.get(item.url) ?? '';
      sources.push({
        title: item.title && item.title.length > 0 ? item.title : item.url,
        url: item.url,
        snippet,
        ...(item.page_age && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}),
      });
      if (sources.length >= maxResults) return sources;
    }
  }
  return sources;
}

export function createDeepSeekProvider(): SearchProvider {
  return {
    id: 'deepseek',
    label: 'DeepSeek 联网搜索',
    description:
      'DeepSeek 官方联网搜索（Anthropic 兼容 Messages API + 原生 web_search 服务端工具）。与 DeepSeek 模型共用同一 API Key；每次搜索消耗一次模型调用 token，返回逐源摘要与综合答案',

    validateConfig(cfg: ProviderConfig): void {
      if (!cfg.apiKey) {
        throw new Error(
          '未配置 DeepSeek API 密钥（与 DeepSeek 模型共用同一 Key），或设置环境变量 DEEPSEEK_API_KEY。可前往 https://platform.deepseek.com 获取。',
        );
      }
    },

    async search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse> {
      const apiKey = cfg.apiKey;
      const endpoint = `${cfg.baseURL || DEEPSEEK_DEFAULT_BASE_URL}/messages`;
      const maxResults = params.max_results ?? 5;

      const body = {
        model: cfg.model || DEEPSEEK_DEFAULT_MODEL,
        max_tokens: cfg.maxTokens || DEEPSEEK_DEFAULT_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: buildSearchInstruction(params.query) }],
          },
        ],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: cfg.maxUses || DEEPSEEK_DEFAULT_MAX_USES,
          },
        ],
      };

      const startTime = Date.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error', // DSH 同款：拒绝重定向，防止端点配置漂移
        headers: {
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
          'anthropic-version': cfg.apiVersion || DEEPSEEK_DEFAULT_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      const responseTime = (Date.now() - startTime) / 1000;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMsg = `DeepSeek API 返回错误 (${response.status})`;
        try {
          const err = JSON.parse(errorBody) as { error?: string | { message?: string }; message?: string };
          const detail = typeof err.error === 'string' ? err.error : (err.error?.message ?? err.message);
          if (detail) errorMsg += `：${detail}`;
        } catch {
          if (errorBody) errorMsg += `：${errorBody}`;
        }
        throw new Error(errorMsg);
      }

      const data = (await response.json()) as { content?: AnthropicBlock[] };
      const sources = mapAnthropicResponse(data, maxResults);
      const textBlocks = (data?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string);
      const answer = extractAnswer(textBlocks);

      const cap = (s: string): string => (s.length > CONTENT_MAX_LEN ? s.slice(0, CONTENT_MAX_LEN) + '…' : s);
      const results: SearchResult[] = sources.map((s, i) => ({
        title: s.title,
        url: s.url,
        content: cap(
          s.snippet
            ? s.publishedAt
              ? `[${s.publishedAt}] ${s.snippet}`
              : s.snippet
            : s.publishedAt
              ? `发布时间：${s.publishedAt}`
              : '',
        ),
        // API 无相关性评分，按名次递减合成（duckduckgo 同款约定）
        score: Math.max(0.9 - i * 0.1, 0.1),
        raw_content: null,
      }));

      return { query: params.query, results, answer, response_time: responseTime, credits_used: null };
    },
  };
}
