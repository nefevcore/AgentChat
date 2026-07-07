// ====================================================================
// agent-memory paths —— 路径解析
// ====================================================================

import * as path from 'path';
import { cfg } from './config';

/**
 * 私有记忆文件路径。
 *
 * 使用方向敏感的非对称路径 (agent/counterpart/memory.md)，
 * 因为每个 Agent 对同一对方的记忆是独立的。
 */
export function resolveMemoryPath(agent: string, counterpart: string): string {
  return path.join(cfg().sessionsDir, agent, counterpart, 'memory.md');
}
