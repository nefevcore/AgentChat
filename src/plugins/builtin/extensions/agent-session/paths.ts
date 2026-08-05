// ============================================================
// agent-session paths —— 路径解析
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import { getGlobalConfig } from '@agents/config';

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

// ============================================================
// 社交活动归档（2026-08-03 新增）—— Agent 自己的参与轨迹，仅供复盘分析，不加载回上下文
// ============================================================

/**
 * A→A 自对话归档目录：sessions/<agent>/<agent>/archive/
 * 自对话（agent === counterpart）不写活跃 messages.jsonl（B1），
 * 但按天归档到 self_YYYY-MM-DD.jsonl 供复盘。
 */
export function resolveSelfDialogueArchiveDir(agent: string): string {
  return path.join(sessionsDir(), agent, agent, 'archive');
}

/**
 * A→Group 群聊参与归档目录：sessions/<agent>/group__<group_id>/archive/
 * 群聊消息由 GroupManager 写共享文件，本目录是 A 的视角副本（收到+响应），
 * 按 ISO 周归档到 history_YYYY-WW.jsonl 供分析。
 */
export function resolveGroupParticipationDir(agent: string, groupId: string): string {
  return path.join(sessionsDir(), agent, `group__${groupId}`, 'archive');
}

// ============================================================
// 压缩归档标记（session.compress → postHook 自动 idleArchive）
// ============================================================

/** 压缩标记文件路径（与 messages.jsonl 同目录） */
export function resolveCompressMarkerPath(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(sessionsDir(), lo, hi, '.memory_archive_needed');
}

/** 写入压缩标记 */
export function writeCompressMarker(agentA: string, agentB: string): void {
  const filePath = resolveCompressMarkerPath(agentA, agentB);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const marker = {
    agent: agentA,
    counterpart: agentB,
    markedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf-8');
}
