// ============================================================
// agent-memory paths —— 路径解析
// ============================================================

import * as path from 'path';
import { getGlobalConfig } from '@agents/config';

/**
 * 私有记忆文件路径。
 *
 * 使用方向敏感的非对称路径 (agent/counterpart/memory.md)，
 * 因为每个 Agent 对同一对方的记忆是独立的。
 */
export function resolveMemoryPath(agent: string, counterpart: string): string {
  return path.join(getGlobalConfig().sessionsDir, agent, counterpart, 'memory.md');
}

/**
 * 归档标记文件路径。
 * agent-session 归档后写入此文件，agent-memory 检测到后触发记忆重写。
 */
export function resolveMemoryUpdateMarkerPath(agent: string, counterpart: string): string {
  return path.join(getGlobalConfig().sessionsDir, agent, counterpart, '.memory_update_needed');
}

/**
 * 记忆审查标记文件路径（混合方案：定时 trigger 驱动）。
 *
 * agent-session 归档时，agent-memory 不再直接调 LLM 重写记忆，
 * 而是写入此标记文件。Agent 的每日定时 trigger 检测到此标记后，
 * 自行读取 pending + memory.md 并决定更新策略。
 */
export function resolveMemoryReviewMarkerPath(agent: string, counterpart: string): string {
  return path.join(getGlobalConfig().sessionsDir, agent, counterpart, '.memory_review_needed');
}
