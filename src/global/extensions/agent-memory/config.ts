// ============================================================
// agent-memory config —— 长期记忆配置
//
// 配置来源（优先级从低到高）：
//   1. 下方 DEFAULTS
//   2. workspace/config.json → "extension.agent_memory" 命名空间
//   3. Agent config.json → "extension.agent_memory" 命名空间（通过 runtimeConfig）
// ============================================================

import type { AgentContext } from '../../../core/types';
import { resolveNamespaceConfig } from '../../../core/config';

/** agent-memory 扩展配置 */
export interface MemoryConfig {
  /** 最大记忆事实条数 */
  maxMemoryFacts: number;
}

export const MEMORY_CONFIG_DEFAULTS: MemoryConfig = {
  maxMemoryFacts: 50,
};

const NAMESPACE = 'extension.agent_memory';

/**
 * 获取当前生效的记忆配置。
 * 合并顺序：默认值 → 全局命名空间 → Agent 级 runtimeConfig
 */
export function cfg(ctx?: AgentContext): MemoryConfig {
  return resolveNamespaceConfig(NAMESPACE, MEMORY_CONFIG_DEFAULTS, ctx?.runtimeConfig);
}
