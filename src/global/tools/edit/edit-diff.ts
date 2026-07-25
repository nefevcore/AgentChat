// ============================================================
// edit-diff.ts —— edit 工具核心算法
//
// 职责：
//   1. BOM 剥离
//   2. 行尾检测与归一化（CRLF → LF）
//   3. 模糊匹配（smart quotes、特殊空格等 Unicode 归一化）
//   4. 多 edit 验证与替换（唯一性、重叠检测、反向替换）
//   5. Unified diff 生成
//
// 模糊匹配分三级：
//   Level 0: 精确匹配
//   Level 1: NFKC + trimEnd + 特殊字符归一化
//   Level 2: NFKC + trim（去行首行尾空白）+ 特殊字符归一化
// ============================================================

/** 单个替换编辑 */
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
}

// ============================================================
// BOM 处理
// ============================================================

/** 剥离 UTF-8 BOM（EF BB BF） */
export function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

// ============================================================
// 行尾处理
// ============================================================

export type LineEnding = '\r\n' | '\n';

/** 检测文件使用的行尾风格 */
export function detectLineEnding(content: string): LineEnding {
  // 如果包含 CRLF，判定为 CRLF 风格
  if (content.includes('\r\n')) {
    return '\r\n';
  }
  return '\n';
}

/** 将所有行尾统一为 LF */
export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 将 LF 恢复为原始行尾风格 */
export function restoreLineEndings(content: string, lineEnding: LineEnding): string {
  if (lineEnding === '\r\n') {
    return content.replace(/\n/g, '\r\n');
  }
  return content;
}

// ============================================================
// 模糊匹配
// ============================================================

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

// ============================================================
// 多 edit 替换核心
// ============================================================

/**
 * 对归一化后的内容执行多个精确替换。
 *
 * 验证规则：
 *   1. oldText 不能为空
 *   2. 每个 oldText 在原始内容中必须唯一（出现次数 === 1）
 *   3. 多个 edit 的匹配范围不能重叠
 *
 * 替换策略：从后往前替换，保证前面的偏移量不变。
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: ReplaceEdit[],
  filePath: string,
): AppliedEditsResult {
  if (edits.length === 0) {
    return { baseContent: normalizedContent, newContent: normalizedContent };
  }

  // 每个 edit 的匹配信息
  interface EditMatch {
    edit: ReplaceEdit;
    index: number;
    usedFuzzyMatch: boolean;
  }

  const matches: EditMatch[] = [];

  for (const edit of edits) {
    // 1. oldText 不能为空
    if (edit.oldText.length === 0) {
      throw new Error(
        `编辑失败：oldText 不能为空。请提供要替换的精确文本。`
      );
    }

    // 2. 在归一化后的内容中查找
    const matchResult = fuzzyFindText(normalizedContent, edit.oldText);

    if (!matchResult.found) {
      throw new Error(
        `在 "${filePath}" 中未找到 oldText。` +
        `oldText 必须精确匹配文件中的内容（包括所有空白和换行）。` +
        `\n未找到的文本："""\n${edit.oldText.slice(0, 300)}"""` +
        (edit.oldText.length > 300 ? '\n...（已截断）' : '')
      );
    }

    // 3. 检查唯一性：统计 oldText 在原内容中的出现次数
    const occurrences = countOccurrences(
      normalizedContent,
      matchResult.usedFuzzyMatch
        ? (matchResult.fuzzyLevel >= 2
            ? normalizeForFuzzyMatch(normalizedContent, true)
            : normalizeForFuzzyMatch(normalizedContent, false))
        : normalizedContent,
      edit.oldText,
      matchResult.usedFuzzyMatch,
      matchResult.fuzzyLevel,
    );

    if (occurrences > 1) {
      throw new Error(
        `在 "${filePath}" 中 oldText 出现了 ${occurrences} 次。` +
        `oldText 必须唯一。请提供更多上下文使其唯一。` +
        `\n重复文本："""\n${edit.oldText.slice(0, 300)}"""` +
        (edit.oldText.length > 300 ? '\n...（已截断）' : '')
      );
    }

    matches.push({
      edit,
      index: matchResult.index,
      usedFuzzyMatch: matchResult.usedFuzzyMatch,
    });
  }

  // 4. 检测重叠：按位置排序后检查相邻 edit 是否交叉
  matches.sort((a, b) => a.index - b.index);

  for (let i = 0; i < matches.length - 1; i++) {
    const currentEnd = matches[i].index + matches[i].edit.oldText.length;
    if (currentEnd > matches[i + 1].index) {
      throw new Error(
        `编辑重叠：edit[${i}] 和 edit[${i + 1}] 的匹配范围重叠。` +
        `请确保每个 oldText 匹配的内容在文件中不互相交叉。`
      );
    }
  }

  // 5. 从后往前替换
  let result = normalizedContent;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { edit, index } = matches[i];
    result = result.slice(0, index) + edit.newText + result.slice(index + edit.oldText.length);
  }

  return { baseContent: normalizedContent, newContent: result };
}

/** 统计 oldText 在 content 中的出现次数 */
function countOccurrences(
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

// ============================================================
// Diff 生成
// ============================================================

/**
 * 生成 unified diff 风格的输出。
 * 返回 diff 文本和第一个变更所在的行号（1-based）。
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines: number = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // 简化版 Myers diff：找到变更区域
  const changes = computeChanges(oldLines, newLines);

  if (changes.length === 0) {
    return { diff: '（无变更）', firstChangedLine: undefined };
  }

  const diffLines: string[] = [];
  let firstChangedLine: number | undefined;

  for (const change of changes) {
    const ctxStart = Math.max(0, change.oldStart - contextLines);
    const ctxEnd = Math.min(oldLines.length, change.oldEnd + contextLines);

    // 上下文头部
    if (diffLines.length > 0) {
      diffLines.push('...');
    }

    // 上下文行（变更前）
    for (let i = ctxStart; i < change.oldStart; i++) {
      diffLines.push(`  ${i + 1} ${oldLines[i]}`);
    }

    // 删除的行
    if (firstChangedLine === undefined && change.oldStart < change.oldEnd) {
      firstChangedLine = change.oldStart + 1;
    } else if (firstChangedLine === undefined) {
      firstChangedLine = change.oldStart + 1;
    }

    for (let i = change.oldStart; i < change.oldEnd; i++) {
      diffLines.push(`- ${i + 1} ${oldLines[i]}`);
    }

    // 添加的行
    for (let i = change.newStart; i < change.newEnd; i++) {
      diffLines.push(`+ ${i + 1} ${newLines[i]}`);
    }

    // 上下文行（变更后）
    for (let i = change.oldEnd; i < ctxEnd; i++) {
      diffLines.push(`  ${i + 1} ${oldLines[i]}`);
    }
  }

  return {
    diff: diffLines.join('\n'),
    firstChangedLine,
  };
}

interface Change {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** 简单的逐行 diff：找出变化的连续块 */
function computeChanges(oldLines: string[], newLines: string[]): Change[] {
  const changes: Change[] = [];

  // 使用 LCS 找到公共子序列
  const lcsMatrix = buildLCSMatrix(oldLines, newLines);
  const lcsPairs = backtrackLCS(lcsMatrix, oldLines, newLines);

  if (lcsPairs.length === 0 && oldLines.length === 0 && newLines.length === 0) {
    return [];
  }

  // 从 LCS 反推变更区域
  const changes_raw: Change[] = [];
  let oldPos = 0;
  let newPos = 0;

  for (const [ol, nl] of lcsPairs) {
    if (oldPos < ol || newPos < nl) {
      changes_raw.push({
        oldStart: oldPos,
        oldEnd: ol,
        newStart: newPos,
        newEnd: nl,
      });
    }
    oldPos = ol + 1;
    newPos = nl + 1;
  }

  // 尾部变更
  if (oldPos < oldLines.length || newPos < newLines.length) {
    changes_raw.push({
      oldStart: oldPos,
      oldEnd: oldLines.length,
      newStart: newPos,
      newEnd: newLines.length,
    });
  }

  // 合并相邻变更
  return mergeAdjacentChanges(changes_raw);
}

function buildLCSMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

function backtrackLCS(
  dp: number[][],
  a: string[],
  b: string[],
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return pairs;
}

function mergeAdjacentChanges(changes: Change[]): Change[] {
  if (changes.length <= 1) return changes;

  const merged: Change[] = [changes[0]];

  for (let i = 1; i < changes.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = changes[i];

    // 如果相邻（间隔 <= 2 行上下文），合并
    if (curr.oldStart <= prev.oldEnd + 2 && curr.newStart <= prev.newEnd + 2) {
      prev.oldEnd = curr.oldEnd;
      prev.newEnd = curr.newEnd;
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
