// ============================================================
// ac-edit-core/src/diff.ts —— unified diff 生成（src edit 原样继承）
//
// 两条路径：
//   1. generateIncrementalDiff —— 基于已知编辑位置，O(edits×contextLines)
//   2. generateDiffString —— 全量 LCS 比对（混合编辑 / 兜底）
// ============================================================

import type { EditPosition } from './types.ts';

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
  contextLines = 4,
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
    let oldEnd = charToLine(oldLineBreaks, endPos);
    if (endPos >= oldContent.length || oldContent[endPos] === '\n') {
      oldEnd += 1;
    }
    oldRanges.push({ start: oldStart, end: oldEnd });

    // new 行范围（考虑前面编辑造成的偏移）
    const newStart = charToLine(newLineBreaks, pos.oldCharStart + cumulativeOffset);
    const newEndPos = pos.oldCharStart + cumulativeOffset + pos.newCharLen;
    let newEnd = charToLine(newLineBreaks, newEndPos);
    if (newEndPos >= newContent.length || newContent[newEndPos] === '\n') {
      newEnd += 1;
    }
    newRanges.push({ start: newStart, end: newEnd });

    cumulativeOffset += pos.newCharLen - pos.oldCharLen;
  }

  // ── 合并相邻范围 ──
  const merged = mergeLineRanges(oldRanges, newRanges);

  // ── 生成 diff ──
  return renderDiff(oldLines, newLines, merged, contextLines);
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
  let lo = 0;
  let hi = breaks.length;
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

interface LineRange {
  start: number;
  end: number;
} // 0-based, 左闭右开

interface MergedRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function mergeLineRanges(oldRanges: LineRange[], newRanges: LineRange[]): MergedRange[] {
  if (oldRanges.length === 0) return [];

  const merged: MergedRange[] = [
    {
      oldStart: oldRanges[0].start,
      oldEnd: oldRanges[0].end,
      newStart: newRanges[0].start,
      newEnd: newRanges[0].end,
    },
  ];

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
// Diff 生成（全量 LCS —— 混合编辑 / 兜底）
// ============================================================

/**
 * 生成 unified diff 风格的输出。
 * 返回 diff 文本和第一个变更所在的行号（1-based）。
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const changes = computeChanges(oldLines, newLines);
  if (changes.length === 0) {
    return { diff: '（无变更）', firstChangedLine: undefined };
  }

  // LCS 变更块 → 渲染范围
  const merged: MergedRange[] = changes.map((c) => ({
    oldStart: c.oldStart,
    oldEnd: c.oldEnd,
    newStart: c.newStart,
    newEnd: c.newEnd,
  }));
  return renderDiff(oldLines, newLines, merged, contextLines);
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
  const changesRaw: Change[] = [];
  let oldPos = 0;
  let newPos = 0;

  for (const [ol, nl] of lcsPairs) {
    if (oldPos < ol || newPos < nl) {
      changesRaw.push({
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
    changesRaw.push({
      oldStart: oldPos,
      oldEnd: oldLines.length,
      newStart: newPos,
      newEnd: newLines.length,
    });
  }

  // 合并相邻变更
  return mergeAdjacentChanges(changesRaw);
}

function buildLCSMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

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

function backtrackLCS(dp: number[][], a: string[], b: string[]): Array<[number, number]> {
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

// ============================================================
// 渲染（共享：增量与全量两条路径输出同格式）
// ============================================================

function renderDiff(
  oldLines: string[],
  newLines: string[],
  merged: MergedRange[],
  contextLines: number,
): { diff: string; firstChangedLine: number | undefined } {
  const diffLines: string[] = [];
  let firstChangedLine: number | undefined;

  for (let ri = 0; ri < merged.length; ri++) {
    const r = merged[ri];
    const ctxStart = Math.max(0, r.oldStart - contextLines);
    const ctxEnd = Math.min(oldLines.length, r.oldEnd + contextLines);

    // 上下文头部
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

  return { diff: diffLines.join('\n'), firstChangedLine };
}
