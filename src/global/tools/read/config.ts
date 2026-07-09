// ============================================================
// read 工具配置
//
// 配置来源（优先级从低到高）：
//   1. 下方 DEFAULTS
//   2. workspace/config.json → "tool.read" 命名空间
//   3. Agent config.json → "tool.read" 命名空间（通过 runtimeConfig）
// ============================================================

import { resolveNamespaceConfig } from '../../../core/config';

export interface ReadConfig {
  /** 输出截断最大行数 */
  maxLines: number;
  /** 输出截断最大字节数 */
  maxBytes: number;
}

export const READ_CONFIG_DEFAULTS: ReadConfig = {
  maxLines: 2000,
  maxBytes: 50 * 1024, // 50KB
};

const NAMESPACE = 'tool.read';

/**
 * 解析 read 工具配置。
 * @param runtimeCfg 可选的 Agent 级运行时覆盖
 */
export function resolveReadConfig(
  runtimeCfg?: Record<string, Record<string, unknown>>,
): ReadConfig {
  return resolveNamespaceConfig(NAMESPACE, READ_CONFIG_DEFAULTS, runtimeCfg);
}
