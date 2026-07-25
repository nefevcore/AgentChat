// ============================================================
// web_search 共享类型 & SearchProvider 接口
//
// 每个搜索 API 实现一个 SearchProvider，在 tool.ts 中按配置选择。
// ============================================================

import type { ConfigField } from '@discovery/config-types';

/** 传递给 provider 的运行时配置（apiKey 来自 config.json 或环境变量） */
export interface ProviderConfig {
  /** API 密钥（由上层从 WebSearchConfig + env 合并后传入） */
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

/** 搜索请求参数（标准化输入，与 provider 无关） */
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

/**
 * SearchProvider 接口 —— 每个搜索 API 必须实现此接口。
 *
 * 实现要点：
 *   · validateConfig(cfg) 检查 apiKey 等配置，缺失则 throw
 *   · search(params, cfg) 使用 cfg.apiKey 调用 API
 *   · configuration 字段注册 UI 可编辑的配置项
 */
export interface SearchProvider {
  /** 提供商标识（如 "tavily"、"serpapi"、"brave"、"duckduckgo"） */
  readonly id: string;
  /** 显示名称 */
  readonly label: string;
  /** 简短描述 */
  readonly description: string;

  /** 校验配置完整性（API Key 等），失败抛出 Error */
  validateConfig(cfg: ProviderConfig): void;

  /** 执行搜索 */
  search(params: SearchParams, cfg: ProviderConfig): Promise<SearchResponse>;

  /** 该 provider 的 UI 配置字段（显示在 Agent 配置面板） */
  readonly configuration: ConfigField[];
}

/** Provider 构造函数类型 */
export type SearchProviderFactory = () => SearchProvider;
