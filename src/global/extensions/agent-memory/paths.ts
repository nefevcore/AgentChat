// ============================================================
// agent-memory paths —— 路径解析
// ============================================================

import * as path from 'path';
import { getGlobalConfig } from '../../../core/config';

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
 * 待处理交换缓冲区路径。
 * 每轮对话的摘要累积在此文件中，直到归档触发记忆重写。
 */
export function resolveMemoryPendingPath(agent: string, counterpart: string): string {
  return path.join(getGlobalConfig().sessionsDir, agent, counterpart, '.memory_pending.jsonl');
}

/**
 * 归档标记文件路径。
 * agent-session 归档后写入此文件，agent-memory 检测到后触发记忆重写。
 */
export function resolveMemoryUpdateMarkerPath(agent: string, counterpart: string): string {
  return path.join(getGlobalConfig().sessionsDir, agent, counterpart, '.memory_update_needed');
}
