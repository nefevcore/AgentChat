// ============================================================
// web_search 共享类型 & SearchProvider 接口（照搬旧 mod tools/web_search/types）
// ============================================================

/** 传递给 provider 的运行时配置（apiKey 来自 config.json 或环境变量） */
export interface ProviderConfig {
  apiKey: string;
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
