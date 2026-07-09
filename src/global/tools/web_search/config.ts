// ============================================================
// web_search 工具配置
//
// 配置来源（优先级从低到高）：
//   1. 下方 DEFAULTS
//   2. workspace/config.json → "tool.web_search" 命名空间
//   3. Agent config.json → "tool.web_search" 命名空间（通过 runtimeConfig）
// ============================================================

import { resolveNamespaceConfig } from '../../../core/config';

export interface WebSearchConfig {
  /** 默认返回结果数 */
  defaultResults: number;
  /** 默认搜索深度 */
  defaultDepth: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  /** 默认搜索类别 */
  defaultTopic: 'general' | 'news' | 'finance';
  /** 原始内容截断长度（字符） */
  rawContentMaxLen: number;
}

export const WEB_SEARCH_CONFIG_DEFAULTS: WebSearchConfig = {
  defaultResults: 5,
  defaultDepth: 'advanced',
  defaultTopic: 'general',
  rawContentMaxLen: 2000,
};

const NAMESPACE = 'tool.web_search';

/**
 * 解析 web_search 工具配置。
 * @param runtimeCfg 可选的 Agent 级运行时覆盖
 */
export function resolveWebSearchConfig(
  runtimeCfg?: Record<string, Record<string, unknown>>,
): WebSearchConfig {
  return resolveNamespaceConfig(NAMESPACE, WEB_SEARCH_CONFIG_DEFAULTS, runtimeCfg);
}
