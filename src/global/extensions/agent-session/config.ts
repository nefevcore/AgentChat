// ============================================================
// agent-session config —— 会话持久化配置
//
// 配置来源（优先级从低到高）：
//   1. 下方 DEFAULTS
//   2. workspace/config.json → "extension.agent_session" 命名空间
//   3. Agent config.json → "extension.agent_session" 命名空间（通过 runtimeConfig）
// ============================================================

import type { AgentContext } from '../../../core/types';
import { resolveNamespaceConfig } from '../../../core/config';

/** agent-session 扩展配置 */
export interface SessionConfig {
  /** 上下文压缩触发阈值（估算 token 数），超过即压缩 */
  maxContextTokens: number;
  /** 上下文压缩时保留的最近消息比例 */
  keepRecentRatio: number;
  /** 压缩摘要中每条消息的预览截断长度（字符） */
  summaryPreviewLen: number;
  /** 空闲归档阈值（秒），超过此时间无对话则自动归档 */
  idleArchiveSec: number;
  /** 历史消息查询默认条数 */
  messageQueryDefaultLimit: number;
}

export const SESSION_CONFIG_DEFAULTS: SessionConfig = {
  maxContextTokens: 100_000,
  keepRecentRatio: 0.10,
  summaryPreviewLen: 200,
  idleArchiveSec: 30 * 60, // 30 分钟
  messageQueryDefaultLimit: 50,
};

const NAMESPACE = 'extension.agent_session';

/**
 * 获取当前生效的会话配置。
 * 合并顺序：默认值 → 全局命名空间 → Agent 级 runtimeConfig
 */
export function cfg(ctx?: AgentContext): SessionConfig {
  return resolveNamespaceConfig(NAMESPACE, SESSION_CONFIG_DEFAULTS, ctx?.runtimeConfig);
}
