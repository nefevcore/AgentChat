// ============================================================
// agent-session paths —— 路径解析
// ============================================================

import * as path from 'path';
import { getGlobalConfig } from '../../../core/config';

/** 获取会话目录路径 */
const sessionsDir = () => getGlobalConfig().sessionsDir;

/**
 * 消息文件路径（Canonical Ordering）。
 *
 * 设计：双方 agent ID 按字母序排序 → 解析到同一物理文件，实现"逻辑双写、物理唯一"。
 *
 * 注意与 resolveMemoryPath 的区别：
 *   - 消息是双方共享的，使用排序后的对称路径 (lo/hi/messages.jsonl)
 *   - 记忆是各方私有的，使用方向敏感的非对称路径 (agent/counterpart/memory.md)
 */
export function resolveMessagePath(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(sessionsDir(), lo, hi, 'messages.jsonl');
}

/**
 * 私有记忆文件路径。
 *
 * 与 resolveMessagePath 不同，此处使用方向敏感的非对称路径
 * (agent/counterpart/memory.md)，因为每个 Agent 对同一对方的记忆是独立的。
 */
export function resolveMemoryPath(agent: string, counterpart: string): string {
  return path.join(sessionsDir(), agent, counterpart, 'memory.md');
}

/** 归档目录路径（使用 Canonical Ordering，与消息文件同目录） */
export function resolveArchiveDir(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(sessionsDir(), lo, hi, 'archive');
}
