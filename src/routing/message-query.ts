// ============================================================
// MessageQuery —— 消息查询服务（只读）
//
// 职责：
//   1. 提供 query() 接口供 WebUI 历史 API 使用
//   2. 使用 Canonical Path 读取 messages.jsonl
//
// 注意：消息写入已迁移到 agent-session 扩展的 postHook
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';
import type { PersistedMessage } from '@global/agent-core/extensions/agent-session/types';

// ============================================================
// 路径（与 agent-session 扩展保持一致）
// ============================================================

/**
 * Canonical Ordering：消息路径按字母序确定
 */
export function resolveMessagePath(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(getGlobalConfig().sessionsDir, lo, hi, 'messages.jsonl');
}

/** 归档目录路径 */
function resolveArchiveDir(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return path.join(getGlobalConfig().sessionsDir, lo, hi, 'archive');
}

// ============================================================
// IMessageQuery 接口
// ============================================================

export interface IMessageQuery {
  /**
   * 查询历史消息
   * @param from 一方 Agent ID
   * @param to   另一方 Agent ID
   */
  query(filter: {
    from: string;
    to: string;
    limit?: number;
    offset?: number;
  }): Promise<PersistedMessage[]>;
}

// ============================================================
// FileMessageQuery 实现（纯查询）
// ============================================================

/** 非 tool 角色：仅这些角色计入 limit/offset */
const AGENT_ROLES = new Set(['agent', 'system', 'error']);

export class FileMessageQuery implements IMessageQuery {
  /**
   * 查询双方之间的对话历史（含归档）。
   * 使用 Canonical Path，from/to 顺序无关。
   *
   * limit/offset 按 Agent 消息（非 tool）计数，tool 消息免费附带。
   * 例如 limit=10 会返回约 10 条 user/assistant 消息，以及穿插其间的所有 tool 消息。
   *
   * 数据源合并顺序（旧→新）：
   *   archive/history_N.jsonl → ... → archive/history_1.jsonl → messages.jsonl
   * 即：编号越大的归档文件越旧，messages.jsonl 是最新的活跃消息。
   */
  async query(filter: {
    from: string;
    to: string;
    limit?: number;
    offset?: number;
  }): Promise<PersistedMessage[]> {
    const filePath = resolveMessagePath(filter.from, filter.to);

    // 收集所有数据源行（旧→新顺序）
    const allLines: string[] = [];

    // 1. 读取归档文件（history_1 最新, history_N 最旧）
    const archiveDir = resolveArchiveDir(filter.from, filter.to);
    if (fs.existsSync(archiveDir)) {
      const archiveFiles = fs
        .readdirSync(archiveDir)
        .filter((f) => /^history_\d+\.jsonl$/.test(f))
        .sort((a, b) => {
          const na = parseInt(a.match(/^history_(\d+)\.jsonl$/)![1], 10);
          const nb = parseInt(b.match(/^history_(\d+)\.jsonl$/)![1], 10);
          return na - nb; // 升序：history_1, history_2, ...
        });

      for (const archiveFile of archiveFiles) {
        const archivePath = path.join(archiveDir, archiveFile);
        const archiveLines = fs
          .readFileSync(archivePath, 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean);
        allLines.push(...archiveLines);
      }
    }

    // 2. 读取活跃消息文件（最新）
    if (fs.existsSync(filePath)) {
      const mainLines = fs
        .readFileSync(filePath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      allLines.push(...mainLines);
    }

    if (allLines.length === 0) {
      return [];
    }

    // 全部解析为消息数组（旧→新顺序）
    const allMessages: PersistedMessage[] = [];
    for (const line of allLines) {
      try {
        const parsed = JSON.parse(line) as PersistedMessage;
        allMessages.push(parsed);
      } catch {
        // skip invalid lines
      }
    }
    if (allMessages.length === 0) return [];

    const limit = filter.limit ?? getGlobalConfig().messageQueryDefaultLimit;
    const offset = filter.offset ?? 0;

    // 从末尾向前遍历：收够 limit 条 Agent 消息后停止
    // tool 消息不计入 count，但随相邻 Agent 消息免费附带
    const result: PersistedMessage[] = [];
    let agentCount = 0;

    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      const isAgent = AGENT_ROLES.has(msg.role);

      if (isAgent) {
        if (agentCount < offset) {
          agentCount++;
          continue; // 还在 offset 跳过范围内
        }
        agentCount++;
      }

      result.push(msg);

      if (isAgent && agentCount - offset >= limit) break;
    }

    // result 是逆序的，翻转回来
    result.reverse();
    if (process.env.NODE_ENV !== 'production') {
      const a = result.filter(m => AGENT_ROLES.has(m.role)).length;
      const t = result.filter(m => m.role === 'tool').length;
      console.log(`[message-query] limit=${limit} offset=${offset} → ${result.length}条 (agent=${a} tool=${t})`);
    }
    return result;
  }
}
