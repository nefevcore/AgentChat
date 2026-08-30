// ============================================================
// @agentchat/edit —— 文本匹配编辑引擎
//
// 2026-08-20 简化：edit 收敛为 old_string/new_string 单一形态。
// Hashline DSL / 行级定位 / 快照哈希校验已移除（无消费方）。
// ============================================================
export * from './tool';
export * from './types';
export { applyEditBatch, defaultEditOperations } from './executor';
export { applyEditsToNormalizedContent } from './apply';
export { generateIncrementalDiff, generateDiffString } from './diff';
export { normalizeToLF } from './line-ending';
