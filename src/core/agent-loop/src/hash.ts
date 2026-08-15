// ============================================================
// src/core/hash.ts —— 会话键哈希（L1 零依赖）
//
// dialogId → DeepSeek user_id 缓存隔离键。
// 可读 dialogId（chat~a~b / group~gid~aid）经 SHA-256 截断为 32 位 hex，
// 避免下划线/特殊字符对 LLM 侧上下文缓存命名空间的干扰，且长度可控。
//
// 确定性：SHA-256 纯函数，相同 dialogId 恒得到相同哈希 → 会话缓存（user_id）稳定。
// 性能：内存 Map 缓存（同进程内 dialogId 有限），避免每轮重复计算。
// ============================================================

import { createHash } from 'crypto';

const cache = new Map<string, string>();

/** dialogId → 缓存隔离键（确定性；32 位 hex；进程内 memoize） */
export function hashDialogId(dialogId: string): string {
  const hit = cache.get(dialogId);
  if (hit) return hit;
  const h = createHash('sha256').update(dialogId).digest('hex').slice(0, 32);
  cache.set(dialogId, h);
  return h;
}
