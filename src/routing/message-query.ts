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
   * 查询双方之间的对话历史
   * 使用 Canonical Path，from/to 顺序无关
   */
  async query(filter: {
    from: string;
    to: string;
    limit?: number;
    offset?: number;
  }): Promise<PersistedMessage[]> {
    const filePath = resolveMessagePath(filter.from, filter.to);

    if (!fs.existsSync(filePath)) {
      return [];
    }

    // 读取所有行
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);

    // JSONL append-only: 文件末尾是最新消息
    // 取最后 limit 条（跳过 offset），保持时间正序（旧→新）
    const limit = filter.limit ?? getGlobalConfig().messageQueryDefaultLimit;
    const offset = filter.offset ?? 0;
    const end = lines.length - offset;
    const start = Math.max(0, end - limit);
    const page = lines.slice(start, end);

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

