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
import type { PersistedMessage } from '@global/extensions/agent-session/types';

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

export class FileMessageQuery implements IMessageQuery {
  /**
   * 查询双方之间的对话历史（含归档）。
   * 使用 Canonical Path，from/to 顺序无关。
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

    // JSONL append-only: 数组末尾是最新消息（allLines 已按旧→新排列）
    // 取最后 limit 条（跳过 offset），保持时间正序（旧→新）
    const limit = filter.limit ?? getGlobalConfig().messageQueryDefaultLimit;
    const offset = filter.offset ?? 0;
    const end = allLines.length - offset;
    const start = Math.max(0, end - limit);
    const page = allLines.slice(start, end);

    return page
      .map((line) => {
        try {
          return JSON.parse(line) as PersistedMessage;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as PersistedMessage[];
  }
}

