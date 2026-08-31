// ============================================================
// ac-edit-core/src/types.ts —— 编辑引擎共享类型
// ============================================================

/** 单个替换编辑（old_string 模糊匹配） */
export interface ReplaceEdit {
  oldText: string;
  newText: string;
}

/** 模糊匹配结果 */
export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  usedFuzzyMatch: boolean;
  /** 匹配级别：0=精确, 1=trimEnd模糊, 2=trim模糊（去行首空白） */
  fuzzyLevel: number;
}

/** applyEditsToNormalizedContent 的返回结果 */
export interface AppliedEditsResult {
  /** 原始归一化内容（用于 diff 生成） */
  baseContent: string;
  /** 替换后的归一化内容 */
  newContent: string;
  /** 每个 edit 在 baseContent 中的位置信息（用于增量 diff） */
  editPositions: EditPosition[];
}

/** 单个编辑在原始内容中的位置 */
export interface EditPosition {
  /** baseContent 中的字符偏移 */
  oldCharStart: number;
  /** oldText 长度 */
  oldCharLen: number;
  /** newText 长度 */
  newCharLen: number;
}
