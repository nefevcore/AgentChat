// ============================================================
// ac-memory-core/src/index.ts —— 记忆注入预算截断纯库
//
// src agent-memory 的 budget/maxTokens 截断剪除算法提纯库（地图
// §3.2 M14 扩展项；零 cordis 依赖）：
//   · clipMemoryForInjection  token 预算内保留【尾部】近期记忆
//     （近期记忆信息密度高），截断时前置明确标记（模型可感知前文
//     存在而非静默丢头）；代理对安全（复用 ac-text-budget 的
//     逐字符累积算法，不切代理对）
//   · 预算含标记自身（估算后从预算中扣除，截断结果不超预算）
// ============================================================
import { estimateTokens, safeClipByTokens } from 'ac-text-budget';

/** 截断标记（模型可感知"更早内容存在"而非静默丢头） */
export const MEMORY_TRUNCATION_MARKER = '…（更早的记忆已按预算截断）';

/**
 * 记忆文本按 token 预算截断（保留尾部近期记忆）。
 *   · maxTokens <= 0 或预算内 → 原文返回
 *   · 超预算 → 尾部保留 + 前置截断标记（标记开销计入预算）
 * 代理对完整（safeClipByTokens 逐字符累积，不切代理对）。
 */
export function clipMemoryForInjection(memory: string, maxTokens: number): string {
  if (!memory) return memory;
  if (maxTokens <= 0 || estimateTokens(memory) <= maxTokens) return memory;
  const markerBudget = Math.ceil(estimateTokens(MEMORY_TRUNCATION_MARKER)) + 1;
  const clipped = safeClipByTokens(memory, Math.max(maxTokens - markerBudget, 1), true);
  return `${MEMORY_TRUNCATION_MARKER}${clipped.slice(1)}`; // 替换裸省略号为明确标记
}
