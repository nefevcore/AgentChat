// ============================================================
// RunSession —— 会话运行态（v0.5.0 P1 无状态化）
//
// 从 core/agent.ts 抽出：会话级并行改造（2026-08-05）引入的 per-session 状态。
// 一个 Agent 实例可同时处理多个会话（1:1 不同对方 / 群聊），各会话独立执行。
//
// convKey 标识会话：
//   1:1  → `${sender}__${agentId}`
//   群聊 → `group__${groupId}__${agentId}`
// ============================================================

import type { Message } from '@core/types';
import type { LLMUsage } from '@core/types';

export interface RunSession {
  /** 会话键（唯一标识一个会话） */
  convKey: string;
  /** 当前会话对方（sender） */
  sender: string;
  /** DeepSeek 缓存隔离 user_id（格式 <sender>__<receiver>） */
  userId: string;
  /** 转向消息队列：用户/其他 Agent 中途插入的指令（按会话隔离） */
  steeringQueue: Message[];
  /** 本轮累计 Token 用量（per-session） */
  cumulativeUsage?: LLMUsage;
  /** 当前运行 AbortController（优雅关闭/重启时 abort） */
  abortController: AbortController | null;
  /** 当前轮事件关联 ID */
  cid: string;
  /** 本轮 thinking 开始时间（毫秒） */
  thinkingStartTime: number;
}

/** 创建新会话运行态 */
export function createRunSession(convKey: string, sender: string): RunSession {
  return {
    convKey,
    sender,
    userId: '',
    steeringQueue: [],
    cumulativeUsage: undefined,
    abortController: null,
    cid: '',
    thinkingStartTime: 0,
  };
}
