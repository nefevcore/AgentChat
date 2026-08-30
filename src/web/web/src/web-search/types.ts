// ============================================================
// web_search 共享类型 & SearchProvider 接口（照搬旧 mod tools/web_search/types）
// ============================================================

/** 传递给 provider 的运行时配置（apiKey 来自 config.json 或环境变量） */
export interface ProviderConfig {
  apiKey: string;
  // ── DeepSeek 搜索扩展字段（其余 provider 忽略；缺省由 provider 内置默认） ──
  /** Anthropic 兼容端点 base（默认 https://api.deepseek.com/anthropic/v1，勿复用 LLM 聊天 base） */
  baseURL?: string;
  /** 执行搜索的模型 ID（默认 deepseek-v4-flash） */
  model?: string;
  /** 单次请求内服务端搜索工具最多使用次数（默认 5） */
  maxUses?: number;
  /** 单次请求生成 token 上限（默认 4096） */
  maxTokens?: number;
  /** anthropic-version 头（默认 2023-06-01） */
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
  configuration: unknown[];
}

/** Provider 工厂（无参，返回实例） */
export type SearchProviderFactory = () => SearchProvider;
