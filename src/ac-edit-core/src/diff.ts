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
): { diff: string; firstChangedLine: number | undefined; diffAdded: number; diffRemoved: number } {
  if (editPositions.length === 0) {
    return { diff: '（无变更）', firstChangedLine: undefined, diffAdded: 0, diffRemoved: 0 };
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
): { diff: string; firstChangedLine: number | undefined; diffAdded: number; diffRemoved: number } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const changes = computeChanges(oldLines, newLines);
  if (changes.length === 0) {
    return { diff: '（无变更）', firstChangedLine: undefined, diffAdded: 0, diffRemoved: 0 };
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

/** 简单的逐行 diff：找出变化的连续块（Myers O(ND) 内核）。
 *
 * 2026-12 性能整改：原实现为 O(m×n) LCS DP 矩阵（时间与内存双二次），
 * 数千行文件的比对即卡顿主源（文件编辑面板逐版本 diff × 每渲染重算）。
 * Myers 前向路径产出公共行配对（配对数 = LCS 长度——任意最优解下增删
 * 行数统计不变，块划分在歧义输入下可能不同但等价）；前后缀公共行快
 * 路径吸收 append/prepend 型编辑；编辑距离超 MYERS_D_CAP 时中段退化
 * 为单替换块（完全重写的大文件——近似最优，避免病态二次耗时）。 */
const MYERS_D_CAP = 1024;

function computeChanges(oldLines: string[], newLines: string[]): Change[] {
  const N = oldLines.length;
  const M = newLines.length;
  // 前后缀公共行快路径（append/prepend 型编辑免比对，同时缩小 Myers 域）
  let pre = 0;
  while (pre < N && pre < M && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < N - pre && suf < M - pre && oldLines[N - 1 - suf] === newLines[M - 1 - suf]) suf++;
  const midPairs = myersMatchedPairs(oldLines, newLines, pre, N - suf, pre, M - suf);
  const changes: Change[] = [];
  if (midPairs === null) {
    // D 超限：中段整体单块（old 中段全计删、new 中段全计增——近似最优）
    if (pre < N - suf || pre < M - suf) {
      changes.push({ oldStart: pre, oldEnd: N - suf, newStart: pre, newEnd: M - suf });
    }
  } else {
    // 从公共配对反推变更区域（同原 LCS 回溯产物的推导口径）
    let oldPos = pre;
    let newPos = pre;
    for (const [ol, nl] of midPairs) {
      if (oldPos < ol || newPos < nl) {
        changes.push({ oldStart: oldPos, oldEnd: ol, newStart: newPos, newEnd: nl });
      }
      oldPos = ol + 1;
      newPos = nl + 1;
    }
    if (oldPos < N - suf || newPos < M - suf) {
      changes.push({ oldStart: oldPos, oldEnd: N - suf, newStart: newPos, newEnd: M - suf });
    }
  }
  return mergeAdjacentChanges(changes);
}

/** 行等价判定的哨兵键：null/undefined 行与 '' 行在 split 产物中不可区分，
 * 但 null === '' 为 false——保留严格判等语义，避免把空串行误当公共行。 */
function lineKey(s: string | null | undefined): string {
  return s == null ? '\u0000null' : s;
}

/**
 * Myers 贪心前向算法（O(ND)）：返回 aLo..aHi / bLo..bHi 域内的公共行配对
 * （时间序；配对数 = 该域 LCS 长度）。编辑距离 d 超过 MYERS_D_CAP 时返回
 * null（调用方退化处理）。v 数组以 k = x - y 为索引双向使用（负偏移量
 * N；数组长度 2N+1——d ≤ N 保证不越界）；每轮 d 保存快照用于回溯。
 */
function myersMatchedPairs(
  a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number,
): Array<[number, number]> | null {
  const N = aHi - aLo;
  const M = bHi - bLo;
  if (N === 0 || M === 0) return []; // 空（含全等）——无中段配对
  const MAX = N + M;
  const v = new Int32Array(2 * MAX + 1);
  const trace: Int32Array[] = [];
  const vA = a; const vB = b; // 行取用别名（snake 内层高频）
  // 快照预算：总条目 ~2M（Int32 ≈ 16MB 上限）——大文件自动收紧 d 上限
  //（超大编辑距离本就近乎重写，退化单块是诚实近似；小文件不受影响）
  const dCap = Math.min(MYERS_D_CAP, Math.max(16, Math.floor(2_000_000 / (2 * MAX + 1))));
  let foundD = -1;
  for (let d = 0; d <= Math.min(MAX, dCap); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + MAX] < v[k + 1 + MAX])) {
        x = v[k + 1 + MAX]; // 下移（插入）
      } else {
        x = v[k - 1 + MAX] + 1; // 右移（删除）
      }
      let y = x - k;
      while (x < N && y < M && lineKey(vA[aLo + x]) === lineKey(vB[bLo + y])) {
        x++; y++;
      }
      v[k + MAX] = x;
      if (x >= N && y >= M) { foundD = d; break; }
    }
    if (foundD >= 0) break;
  }
  if (foundD < 0) return null;
  // 回溯：逐 d 从终态反推每步的 snake/移动方向，收集公共行配对
  const pairs: Array<[number, number]> = [];
  let x = N;
  let y = M;
  for (let d = foundD; d > 0; d--) {
    const vp = trace[d]; // 轮前快照 = d-1 轮终态（与正向判定同源）
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vp[k - 1 + MAX] < vp[k + 1 + MAX])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vp[prevK + MAX];
    const prevY = prevX - prevK;
    // snake 体：从 (prevX, prevY) 沿对角线到 (x, y) 的公共行
    while (x > prevX && y > prevY) {
      x--; y--;
      pairs.unshift([aLo + x, bLo + y]);
    }
    x = prevX; y = prevY;
  }
  // d=0 的 snake（全等域——前缀快路径后不会出现，防御性收集）
  while (x > 0 && y > 0) {
    x--; y--;
    pairs.unshift([aLo + x, bLo + y]);
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
): { diff: string; firstChangedLine: number | undefined; diffAdded: number; diffRemoved: number } {
  const diffLines: string[] = [];
  let firstChangedLine: number | undefined;
  // 行级增删统计（工具卡 Label 的 +N -M 数据源）
  let diffAdded = 0;
  let diffRemoved = 0;

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
      diffRemoved++;
    }
    for (let i = r.newStart; i < r.newEnd; i++) {
      diffLines.push(`+ ${i + 1} ${newLines[i]}`);
      diffAdded++;
    }

    // 上下文行（变更后）
    for (let i = r.oldEnd; i < ctxEnd; i++) {
      diffLines.push(`  ${i + 1} ${oldLines[i]}`);
    }
  }

  return { diff: diffLines.join('\n'), firstChangedLine, diffAdded, diffRemoved };
}

// ============================================================
// 行级增删统计（整文件语义——write 覆盖/前缀无关）
// ============================================================

/**
 * 整文件行级变更统计（unified diff 语义——前缀无关）：行 LCS 定位变更块，
 * 块内 old 侧全部计删除、new 侧全部计新增（与 generateDiffString 渲染的
 * -/+ 行数一致——write 覆盖同内容 0/0、改共享尾文件仅计差异块）。
 */
export function countLineChanges(a: string, b: string): { added: number; removed: number } {
  // 快路径：内容一致（write 覆盖同内容）——零成本短路
  if (a === b) return { added: 0, removed: 0 };
  const oldLines = a.split('\n');
  const newLines = b.split('\n');
  const changes = computeChanges(oldLines, newLines);
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    removed += c.oldEnd - c.oldStart;
    added += c.newEnd - c.newStart;
  }
  return { added, removed };
}
