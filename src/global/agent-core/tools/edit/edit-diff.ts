// ============================================================
// edit-diff.ts —— edit 工具核心算法
//
// 职责：
//   1. BOM 剥离
//   2. 行尾检测与归一化（CRLF -> LF）
//   3. 模糊匹配（smart quotes、特殊空格等 Unicode 归一化）
//   4. 多 edit 验证与替换（唯一性、重叠检测、反向替换）
//   5. 哈希编辑（O(1) 行定位，零模糊匹配）
//   6. Unified diff 生成（增量 / 全量 LCS）
//
// 模糊匹配分三级：
//   Level 0: 精确匹配
//   Level 1: NFKC + trimEnd + 特殊字符归一化
//   Level 2: NFKC + trim（去行首行尾空白）+ 特殊字符归一化
// ============================================================

import { hashLine } from '../shared';

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

/** 哈希编辑参数（替代 oldText，用于 O(1) 精确定位） */
export interface HashEdit {
  /** 行 Hash 前缀 */
  lineHash: string;
  /** 替换后的文本（可含换行） */
  newText: string;
}

/** applyEditsToNormalizedContent 的返回结果 */
export interface AppliedEditsResult {
  /** 原始归一化内容（用于 diff 生成） */
  baseContent: string;
  /** 替换后的归一化内容 */
  newContent: string;
  /** 每个 edit 在 baseContent 中的位置信息（用于增量 diff） */
  editPositions: EditPosition[];
  /** hash 编辑后更新的行哈希（供 Agent 下次 edit 直接使用） */
  updatedHashInfo: HashUpdateInfo[];
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

/** hash 编辑后更新的行哈希信息，供 Agent 下次 edit 直接使用，无需重新 read */
export interface HashUpdateInfo {
  /** 被替换行的原始 hash */
  oldHash: string;
  /** 替换后每行的新 hash（newText 可能含换行，拆为多行） */
  newHashes: string[];
}

// ============================================================

/** 对文件每一行计算哈希（行内容不含换行符） */
function hashLines(lines: string[]): string[] {
  return lines.map(hashLine);
}

// ============================================================
// 哈希编辑（O(lines) 定位，无搜索，无模糊匹配）
// ============================================================

/**
 * 基于行哈希执行编辑。
 *
 * 流程：
 *   1. 计算当前文件每行的哈希
 *   2. 对每个 HashEdit，通过 lineHash 在哈希表中查找行号
 *   3. 若哈希不匹配（并发修改），拒绝编辑
 *   4. 从后往前替换，保持偏移
 */
export function applyHashBasedEdits(
  normalizedContent: string,
  hashEdits: HashEdit[],
  filePath: string,
): AppliedEditsResult {
  if (hashEdits.length === 0) {
    return { baseContent: normalizedContent, newContent: normalizedContent, editPositions: [], updatedHashInfo: [] };
  }

  const lines = normalizedContent.split('\n');
  const hashes = hashLines(lines);

  // 构建 hash → 行号映射（如果重复，只保留第一次出现）
  const hashToLine = new Map<string, number>();
  for (let i = 0; i < hashes.length; i++) {
    if (!hashToLine.has(hashes[i])) {
      hashToLine.set(hashes[i], i);
    }
  }

  interface HashMatch {
    lineNum: number;   // 0-based
    edit: HashEdit;
  }

  const matches: HashMatch[] = [];

  for (const he of hashEdits) {
    const lineNum = hashToLine.get(he.lineHash);
    if (lineNum === undefined) {
      throw new Error(
        `在 "${filePath}" 中未找到 lineHash="${he.lineHash}"。` +
        `文件内容可能已被修改，请重新 read 获取最新哈希。`
      );
    }

    // 并发修改检测：重新计算该行的哈希，确保一致
    const currentHash = hashLine(lines[lineNum]);
    if (currentHash !== he.lineHash) {
      throw new Error(
        `行哈希冲突：lineHash="${he.lineHash}" 指向第 ${lineNum + 1} 行，` +
        `但该行当前哈希为 "${currentHash}"，文件可能已被并发修改。` +
        `请重新 read 获取最新哈希。`
      );
    }

    matches.push({ lineNum, edit: he });
  }

  // 检测重叠
  matches.sort((a, b) => a.lineNum - b.lineNum);
  for (let i = 0; i < matches.length - 1; i++) {
    if (matches[i].lineNum === matches[i + 1].lineNum) {
      throw new Error(
        `编辑重叠：两个 edit 都指向第 ${matches[i].lineNum + 1} 行（lineHash="${matches[i].edit.lineHash}"）。`
      );
    }
  }

  // 从后往前替换
  let result = normalizedContent;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { lineNum, edit } = matches[i];
    const oldLine = lines[lineNum];
    // 找到 oldLine 在 result 中的位置（因为有前面的替换可能改变了偏移）
    // 这里用行号重新定位
    const currentLines = result.split('\n');
    currentLines[lineNum] = edit.newText;
    result = currentLines.join('\n');
  }

  // 构建 editPositions
  const editPositions: EditPosition[] = [];
  for (const m of matches) {
    // 计算原始内容中该行的字符偏移
    let charOffset = 0;
    for (let i = 0; i < m.lineNum; i++) {
      charOffset += lines[i].length + 1; // +1 for \n
    }
    editPositions.push({
      oldCharStart: charOffset,
      oldCharLen: lines[m.lineNum].length,
      newCharLen: m.edit.newText.length,
    });
  }

  // 计算 hash 更新信息：每个被替换行的旧 hash → 新行 hash 列表
  const updatedHashInfo: HashUpdateInfo[] = matches.map(m => ({
    oldHash: m.edit.lineHash,
    newHashes: m.edit.newText.split('\n').map(l => hashLine(l)),
  }));

  return { baseContent: normalizedContent, newContent: result, editPositions, updatedHashInfo };
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
    return { baseContent: normalizedContent, newContent: normalizedContent, editPositions: [] , updatedHashInfo: [] };
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

  // 6. 收集编辑位置（用于增量 diff）
  const editPositions = matches.map(m => ({
    oldCharStart: m.index,
    oldCharLen: m.edit.oldText.length,
    newCharLen: m.edit.newText.length,
  }));

  return { baseContent: normalizedContent, newContent: result, editPositions , updatedHashInfo: [] };
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
// 增量 Diff 生成（基于编辑位置，避免 O(m×n) LCS）
// ============================================================

/**
 * 基于编辑位置生成 unified diff。
 *
 * 与 generateDiffString 不同，此函数利用 applyEditsToNormalizedContent
 * 已知的编辑位置，跳过全量 LCS 比对，直接定位变更区域。
 *
 * 时间复杂度 O(edits × contextLines)，原 LCS 方案 O(m×n)。
 */
export function generateIncrementalDiff(
  oldContent: string,
  newContent: string,
  editPositions: EditPosition[],
  contextLines: number = 4,
): { diff: string; firstChangedLine: number | undefined } {
  if (editPositions.length === 0) {
    return { diff: '（无变更）', firstChangedLine: undefined };
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // ── 计算 old 中每个编辑的行范围 ──
  // 使用前缀数组加速查找（一次遍历）
  const oldLineBreaks = findLineBreaks(oldContent);
  const newLineBreaks = findLineBreaks(newContent);

  const oldRanges: LineRange[] = [];
  const newRanges: LineRange[] = [];
  let cumulativeOffset = 0; // newContent 相对于 oldContent 的累积字符偏移

  for (const pos of editPositions) {
    // old 行范围
    const oldStart = charToLine(oldLineBreaks, pos.oldCharStart);
    const endPos = pos.oldCharStart + pos.oldCharLen;
    // charToLine 在位置恰好落在 \n 上时返回该换行符前的行号，
    // 但 oldEnd 应该是 exclusive 边界：第一个不受编辑影响的行。
    // 如果 endPos 落在 \n 上，需要 +1 才能指向下一行。
    let oldEnd = charToLine(oldLineBreaks, endPos);
    if (endPos < oldContent.length && oldContent[endPos] === '\n') {
      oldEnd += 1;
    }
    oldRanges.push({ start: oldStart, end: oldEnd });

    // new 行范围（考虑前面编辑造成的偏移）
    const newStart = charToLine(newLineBreaks, pos.oldCharStart + cumulativeOffset);
    const newEndPos = pos.oldCharStart + cumulativeOffset + pos.newCharLen;
    let newEnd = charToLine(newLineBreaks, newEndPos);
    if (newEndPos < newContent.length && newContent[newEndPos] === '\n') {
      newEnd += 1;
    }
    newRanges.push({ start: newStart, end: newEnd });

    cumulativeOffset += pos.newCharLen - pos.oldCharLen;
  }

  // ── 合并相邻范围 ──
  const merged = mergeLineRanges(oldRanges, newRanges);

  // ── 生成 diff ──
  const diffLines: string[] = [];
  let firstChangedLine: number | undefined;

  for (let ri = 0; ri < merged.length; ri++) {
    const r = merged[ri];
    const ctxStart = Math.max(0, r.oldStart - contextLines);
    const ctxEnd = Math.min(oldLines.length, r.oldEnd + contextLines);

    if (diffLines.length > 0) {
      diffLines.push('...');
    }

    // 上下文行（变更前）
    for (let i = ctxStart; i < r.oldStart; i++) {
      diffLines.push(`  ${i + 1} ${oldLines[i]}`);
    }

    // 变更行
    if (firstChangedLine === undefined) {
      firstChangedLine = r.oldStart + 1;
    }

    for (let i = r.oldStart; i < r.oldEnd; i++) {
      diffLines.push(`- ${i + 1} ${oldLines[i]}`);
    }
    for (let i = r.newStart; i < r.newEnd; i++) {
      diffLines.push(`+ ${i + 1} ${newLines[i]}`);
    }

    // 上下文行（变更后）
    for (let i = r.oldEnd; i < ctxEnd; i++) {
      diffLines.push(`  ${i + 1} ${oldLines[i]}`);
    }
  }

  return {
    diff: diffLines.join('\n'),
    firstChangedLine,
  };
}

/** 查找所有换行符位置（用于 O(1) 字符→行号转换） */
function findLineBreaks(content: string): number[] {
  const breaks: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') breaks.push(i);
  }
  return breaks;
}

/** 将字符偏移转换为行号（0-based），使用前缀数组二分查找 */
function charToLine(breaks: number[], charIndex: number): number {
  // 二分查找：找到第一个 > charIndex 的换行符位置
  let lo = 0, hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid] < charIndex) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

interface LineRange { start: number; end: number } // 0-based, 左闭右开

interface MergedRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function mergeLineRanges(oldRanges: LineRange[], newRanges: LineRange[]): MergedRange[] {
  if (oldRanges.length === 0) return [];

  const merged: MergedRange[] = [{
    oldStart: oldRanges[0].start,
    oldEnd: oldRanges[0].end,
    newStart: newRanges[0].start,
    newEnd: newRanges[0].end,
  }];

  for (let i = 1; i < oldRanges.length; i++) {
    const prev = merged[merged.length - 1];
    const gap = 0; // 仅合并真正相邻的编辑块（不合并中间有未变更行的）
    if (oldRanges[i].start <= prev.oldEnd + gap || newRanges[i].start <= prev.newEnd + gap) {
      prev.oldEnd = oldRanges[i].end;
      prev.newEnd = newRanges[i].end;
    } else {
      merged.push({
        oldStart: oldRanges[i].start,
        oldEnd: oldRanges[i].end,
        newStart: newRanges[i].start,
        newEnd: newRanges[i].end,
      });
    }
  }

  return merged;
}

// ============================================================
// Diff 生成（全量 LCS — 保留用于向后兼容或外部直接调用）
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
