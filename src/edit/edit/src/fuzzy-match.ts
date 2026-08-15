// ============================================================
// fuzzy-match.ts —— oldText 模糊匹配（从 edit-diff.ts 拆出）
//
// 三级匹配策略（消除 LLM 常见输出差异）：
//   Level 0: 精确匹配
//   Level 1: NFKC + trimEnd + 特殊字符归一化
//   Level 2: NFKC + trim（去行首行尾空白）+ 特殊字符归一化
// ============================================================

import type { FuzzyMatchResult } from './types';

/**
 * 对文本做 Unicode 归一化，消除 LLM 常见的输出差异：
 *   - Smart quotes → ASCII quotes
 *   - 各种 dash/hyphen → 标准 hyphen
 *   - 特殊空格 → 普通空格
 *   - 行尾空格 trim（trimLeading=false）或行首行尾 trim（trimLeading=true）
 */
export function normalizeForFuzzyMatch(text: string, trimLeading: boolean = false): string {
  return (
    text
      // Unicode 正规化
      .normalize('NFKC')
      // 按行处理：去除空白
      .split('\n')
      .map((line) => trimLeading ? line.trim() : line.trimEnd())
      .join('\n')
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      // Special spaces → regular space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  );
}

/**
 * 在 content 中查找 oldText。
 * 策略：精确优先 → 模糊兜底（trimEnd） → 激进模糊兜底（trim）。
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // 1. 精确匹配
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, usedFuzzyMatch: false, fuzzyLevel: 0 };
  }

  // 2. 模糊匹配（trimEnd）
  const fuzzyContent = normalizeForFuzzyMatch(content, false);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText, false);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex !== -1) {
    // 由于 normalizeForFuzzyMatch(trimEnd) 仅改变字符样式不改变长度，
    // index 在原始 content 中同样有效
    return { found: true, index: fuzzyIndex, usedFuzzyMatch: true, fuzzyLevel: 1 };
  }

  // 3. 激进模糊匹配（trim 行首行尾空白）—— 处理 LLM 多/少前导空格的情况
  const fuzzyTrimContent = normalizeForFuzzyMatch(content, true);
  const fuzzyTrimOldText = normalizeForFuzzyMatch(oldText, true);
  const fuzzyTrimIndex = fuzzyTrimContent.indexOf(fuzzyTrimOldText);

  if (fuzzyTrimIndex !== -1) {
    // 将 trim 后的索引映射回原始内容的索引
    const originalIndex = mapTrimmedIndexToOriginal(content, fuzzyTrimContent, fuzzyTrimIndex);
    if (originalIndex !== -1) {
      return { found: true, index: originalIndex, usedFuzzyMatch: true, fuzzyLevel: 2 };
    }
  }

  return { found: false, index: -1, usedFuzzyMatch: false, fuzzyLevel: -1 };
}

/**
 * 将 trim（去行首行尾空白）后的索引映射回原始内容的位置。
 *
 * 原理：逐行累加原始内容和 trim 后内容的偏移量，
 * 当 trim 后的位置落在某行内时，返回原始内容中的对应位置。
 */
function mapTrimmedIndexToOriginal(
  original: string,
  trimmed: string,
  trimmedIndex: number,
): number {
  const origLines = original.split('\n');
  const trimmedLines = trimmed.split('\n');

  let origPos = 0;
  let trimmedPos = 0;

  for (let i = 0; i < origLines.length; i++) {
    const origLine = origLines[i];
    const trimmedLine = trimmedLines[i] ?? '';

    // 原始行中前导空白的长度（即被 trimStart 去掉的部分）
    const origTrimStart = origLine.trimStart();
    const leadingWS = origLine.length - origTrimStart.length;

    // 当前 trim 行的结束位置（含换行符）
    const trimmedLineEnd = trimmedPos + trimmedLine.length + 1;

    if (trimmedIndex >= trimmedPos && trimmedIndex < trimmedLineEnd) {
      // 目标位置在当前行内
      const offsetInTrimmedLine = trimmedIndex - trimmedPos;
      return origPos + leadingWS + offsetInTrimmedLine;
    }

    origPos += origLine.length + 1; // +1 for \n
    trimmedPos += trimmedLine.length + 1;
  }

  return -1;
}

/** 统计 oldText 在 content 中的出现次数 */
export function countOccurrences(
  content: string,
  searchIn: string,
  oldText: string,
  useFuzzy: boolean,
  fuzzyLevel: number = 0,
): number {
  const searchText = useFuzzy
    ? normalizeForFuzzyMatch(oldText, fuzzyLevel >= 2)
    : oldText;
  let count = 0;
  let pos = 0;
  while ((pos = searchIn.indexOf(searchText, pos)) !== -1) {
    count++;
    pos += searchText.length;
  }
  return count;
}
