// ============================================================
// ac-edit-core —— 编辑引擎纯库（零 cordis 依赖）
//
// src edit 包 2026-08-20 收敛形态的原样继承（地图审查修正：
// hashline DSL/行级定位/快照校验已在 src 移除，以现状为准）：
//   · fuzzy-match  —— 三级模糊匹配（精确 → NFKC+trimEnd → NFKC+trim）
//   · line-ending  —— BOM 剥离 + 混合换行按行保留（防整文件字节污染）
//   · apply        —— old_string 唯一性/重叠校验 + 从后往前替换
//   · diff         —— 增量 diff（编辑位置已知 O(edits×ctx)）/ 全量 LCS 兜底
//   · mutation-queue —— 同文件写串行化（read/write/edit 共享，一致性）
//   · executor     —— 统一管线（路径解析归调用方，零策略）
// ============================================================
export {
  normalizeForFuzzyMatch,
  fuzzyFindText,
  countOccurrences,
} from './fuzzy-match.ts';
export {
  stripBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  restoreLineEndingsPreserving,
  parseRawLines,
} from './line-ending.ts';
export type { LineEnding, RawLine } from './line-ending.ts';
export { applyEditsToNormalizedContent } from './apply.ts';
export { generateIncrementalDiff, generateDiffString } from './diff.ts';
export { withFileMutationQueue } from './mutation-queue.ts';
export { applyEditBatch } from './executor.ts';
export type { EditBatch, EditBatchResult } from './executor.ts';
export type { ReplaceEdit, FuzzyMatchResult, AppliedEditsResult, EditPosition } from './types.ts';
