// ============================================================
// ac-web-search-core/src/deepseek.ts —— DeepSeek Search Provider
//
// 官方专用检索端点（2026-10-16 上线）：POST {baseURL}/tools/search，
// 与 DeepSeek 模型共用同一 API Key（DEEPSEEK_API_KEY），Bearer 鉴权。
// base 默认 https://api.deepseek.com/v1 —— 与 LLM 聊天的
// https://api.deepseek.com 同源（/v1 路径已在 base 内）。
//
// 前史（已退役，cr-486）：DeepSeek 无专用检索端点时期，曾借
// Anthropic 兼容 Messages API（/anthropic/v1/messages）+ 原生
// web_search_20250305 服务端工具实现搜索——一次搜索 = 一次完整模型
// 回合（计 token、慢、需模型结构化输出解析）。官方端点上线后整体
// 退役；存量配置里的 model/maxUses/maxTokens/apiVersion 键静默忽略。
// ============================================================
import type { ProviderConfig, SearchParams, SearchProvider, SearchResponse, SearchResult } from './types.ts';

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

/** /tools/search 响应结果项（仅声明本 provider 用到的形状） */
interface DeepSeekSearchItem {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  date?: string | null;
}

/**
 * 把 /tools/search 响应映射为标准化搜索结果列表。
 * - content = summary（长摘要，与 query 相关，给模型阅读），缺失回落 snippet
 * - score = rerank_score / 3 归一到 0~1（tavily 同量纲，UI 直出）
 * - date 前缀进 content（无正文时仍是可读信息），url 缺失项跳过
 */
export function mapSearchResponse(
  data: { results?: DeepSeekSearchItem[] } | undefined,
  maxResults: number,
): SearchResult[] {
  const out: SearchResult[] = [];
  for (const item of data?.results ?? []) {
    if (!item.url) continue;
    const publishedAt = item.date && item.date.length > 0 ? item.date : undefined;
    const body = item.summary && item.summary.length > 0 ? item.summary : (item.snippet ?? "");
    out.push({
      title: item.title && item.title.length > 0 ? item.title : item.url,
      url: item.url,
      content: publishedAt ? `[${publishedAt}] ${body}` : body,
      // rerank_score 0~3 → 0~1；两位小数舍入（2.4/3 = 0.7999… 浮点尾差干净化）
      score: typeof item.rerank_score === 'number' && Number.isFinite(item.rerank_score)
        ? Math.round((Math.min(1, Math.max(0, item.rerank_score / 3))) * 100) / 100
        : 0,
      raw_content: null,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function createDeepSeekProvider(): SearchProvider {
  return {
    id: 'deepseek',
    label: 'DeepSeek 联网搜索',
    description:
      'DeepSeek 官方联网搜索 API（POST /v1/tools/search 专用检索端点，2026-10-16 上线）。与 DeepSeek 模型共用同一 API Key；返回带相关性评分（rerank_score）与长摘要（summary）的结构化结果',

    validateConfig(cfg: ProviderConfig): void {
      if (!cfg.apiKey) {
        throw new Error(
          '未配置 DeepSeek API 密钥（与 DeepSeek 模型共用同一 Key），或设置环境变量 DEEPSEEK_API_KEY。可前往 https://platform.deepseek.com 获取。',
        );
      }
    },

    async search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse> {
      const apiKey = cfg.apiKey;
      const endpoint = `${cfg.baseURL || DEEPSEEK_DEFAULT_BASE_URL}/tools/search`;
      const maxResults = params.max_results ?? 5;

      // need_content=false（缺省）：正文恒空、summary 已够模型阅读——
      // 省流量；raw_content 语义（tavily 的全文回传）本 API 无对应字段
      const body = {
        query: params.query,
        count: Math.min(50, Math.max(1, maxResults)),
      };

      const startTime = Date.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error', // 拒绝重定向，防止端点配置漂移
        headers: {
          Authorization: `Bearer ${apiKey}`,
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

      const data = (await response.json()) as { results?: DeepSeekSearchItem[] };
      const results = mapSearchResponse(data, maxResults);

      return { query: params.query, results, answer: null, response_time: responseTime, credits_used: null };
    },
  };
}
