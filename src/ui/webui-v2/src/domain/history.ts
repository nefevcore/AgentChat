// ============================================================
// domain/history.ts —— 历史分页合并（纯函数，可单测）
// ============================================================

import type { ChatMessage } from './types';

/**
 * 历史分页合并：新返回的较早消息在前 + 已有较晚消息在后，按 message_id 去重。
 * @returns [合并去重后的消息, 该页 user 链数]（userCount 用于按轮次校准分页 offset）
 */
export function mergeHistoryPage(
  incoming: ChatMessage[],
  existing: ChatMessage[],
  isFirstPage: boolean,
): { merged: ChatMessage[]; userCount: number } {
  const raw = isFirstPage ? incoming : [...incoming, ...existing];
  const seen = new Set<string>();
  const merged = raw.filter((m) => {
    if (m.persistedMsgId && seen.has(m.persistedMsgId)) return false;
    if (m.persistedMsgId) seen.add(m.persistedMsgId);
    return true;
  });
  const userCount = incoming.filter((m) => m.agent_id === 'user').length;
  return { merged, userCount };
}

/** 每页轮数（后端按 user 链分页） */
export const HISTORY_PAGE_SIZE = 5;
