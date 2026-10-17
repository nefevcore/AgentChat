// ============================================================
// ac-web-search-core/src/types.ts —— web_search 共享类型 & SearchProvider 接口
// （src web/web-search/types 原样平移；零 cordis 依赖）
// ============================================================

/** 传递给 provider 的运行时配置（apiKey 来自 ac-credentials 解析链或环境变量） */
export interface ProviderConfig {
  apiKey: string;
  // ── DeepSeek 搜索扩展字段（其余 provider 忽略；缺省由 provider 内置默认）。
  //    cr-486 换用官方 /v1/tools/search 端点后仅 baseURL 仍被消费；model/
  //    maxUses/maxTokens/apiVersion 为旧 Messages 特型键，存量配置静默忽略 ──
  /** 搜索端点 base（默认 https://api.deepseek.com/v1） */
  baseURL?: string;
  /** @deprecated 旧 Anthropic Messages 特型键——专用搜索端点无模型参数，忽略 */
  model?: string;
  /** @deprecated 旧 Anthropic Messages 特型键——忽略 */
  maxUses?: number;
  /** @deprecated 旧 Anthropic Messages 特型键——忽略 */
  maxTokens?: number;
  /** @deprecated 旧 Anthropic Messages 特型键——忽略 */
  apiVersion?: string;
}

/** 搜索结果单项（标准化输出） */
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

/** 搜索响应（标准化输出） */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answer?: string | null;
  response_time: number;
  credits_used?: number | null;
}

/** 搜索请求参数（标准化输入） */
export interface SearchParams {
  query: string;
  search_depth?: 'basic' | 'advanced';
  max_results?: number;
  topic?: 'general' | 'news' | 'finance';
  include_domains?: string[];
  exclude_domains?: string[];
  time_range?: 'day' | 'week' | 'month' | 'year' | 'd' | 'w' | 'm' | 'y';
  include_answer?: boolean;
  include_raw_content?: boolean;
}

/** SearchProvider 接口 —— 每个搜索 API 必须实现此接口 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  validateConfig(cfg: ProviderConfig): void;
  search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse>;
}

/** Provider 工厂（无参，返回实例） */
export type SearchProviderFactory = () => SearchProvider;
