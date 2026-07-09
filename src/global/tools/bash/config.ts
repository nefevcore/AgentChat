// ============================================================
// bash 工具配置
//
// 配置来源（优先级从低到高）：
//   1. 下方 DEFAULTS
//   2. workspace/config.json → "tool.bash" 命名空间
//   3. Agent config.json → "tool.bash" 命名空间（通过 runtimeConfig）
// ============================================================

import { resolveNamespaceConfig } from '../../../core/config';

export interface BashConfig {
  /** 默认超时（毫秒） */
  defaultTimeout: number;
  /** 最大超时硬上限（毫秒） */
  maxTimeout: number;
  /** 输出截断长度（字符） */
  outputMaxLen: number;
  /** 最大缓冲区（字节） */
  maxBuffer: number;
}

export const BASH_CONFIG_DEFAULTS: BashConfig = {
  defaultTimeout: 30_000,
  maxTimeout: 120_000,
  outputMaxLen: 50_000,
  maxBuffer: 10 * 1024 * 1024, // 10 MB
};

const NAMESPACE = 'tool.bash';

/**
 * 解析 bash 工具配置。
 * @param runtimeCfg 可选的 Agent 级运行时覆盖
 */
export function resolveBashConfig(
  runtimeCfg?: Record<string, Record<string, unknown>>,
): BashConfig {
  return resolveNamespaceConfig(NAMESPACE, BASH_CONFIG_DEFAULTS, runtimeCfg);
}
