// ============================================================
// apply.ts —— 编辑应用（统一模型）
//
// 2026-08-12 重构：DSL 与 JSON 两条路径的行级编辑统一为 LineEdit 模型，
// 由 applyLineEdits 单一实现（从后往前应用 + 行哈希验证）。
// 旧的 applyHashBasedEdits / applyAppendEdits / applyPrependEdits /
// applyRangeEdits 已被统一实现取代（删除）。
//
// 保留的两个应用入口：
//   · applyLineEdits —— 行级编辑（LineEdit[]，统一核心）
//   · applyEditsToNormalizedContent —— oldText 文本匹配（最后执行）
//
// 依赖方向：types / fuzzy-match / hashline-snapshot / ../shared。
// ============================================================

import { hashLine } from '../shared';
import { getSnapshot } from './hashline-snapshot';
import { fuzzyFindText, normalizeForFuzzyMatch, countOccurrences } from './fuzzy-match';
import type {
  ReplaceEdit, LineEdit,
  AppliedEditsResult, EditPosition, HashUpdateInfo, FuzzyMatchResult,
} from './types';

/** 对文件每一行计算哈希（行内容不含换行符） */
function hashLines(lines: string[]): string[] {
  return lines.map(hashLine);
}

/**
 * 从 read 快照解析裸行号的期望哈希（Hashline 裸行号定位）。
 * read v2 只输出 [PATH#TAG] 文件头 + 行号:内容，不提供每行哈希；
 * 编辑时用 read 快照里该行的哈希作为期望值，交由行号+哈希路径验证并发修改。
 */
export function resolveSnapshotHash(absPath: string, lineNum: number): string {
  const snapshot = getSnapshot(absPath);
  if (!snapshot) {
    throw new Error(`无法定位行号：未找到 "${absPath}" 的 read 快照。请先 read 获取 [PATH#TAG] 头部与行号，再编辑。`);
  }
  const lines = snapshot.content.split('\n');
  const idx = lineNum - 1;
  if (idx < 0 || idx >= lines.length) {
    throw new Error(`行号 ${lineNum} 超出 read 时文件范围（共 ${lines.length} 行）。请重新 read。`);
  }
  return hashLine(lines[idx]);
}

// ============================================================
// oldText 文本匹配（字符级，模糊三级）
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
    return { baseContent: normalizedContent, newContent: normalizedContent, editPositions: [], updatedHashInfo: [] };
  }

  // 每个 edit 的匹配信息
  interface EditMatch {
    edit: ReplaceEdit;
    index: number;
    usedFuzzyMatch: boolean;
    /** 在原始 content 中实际匹配到的文本长度（≠ edit.oldText.length 当 fuzzy trimEnd 截短时） */
    matchedLen: number;
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
    const matchResult: FuzzyMatchResult = fuzzyFindText(normalizedContent, edit.oldText);

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

    // 计算匹配文本在原始 content 中的实际长度
    // 模糊匹配 trimEnd 会截短 oldText，所以 matchedLen < edit.oldText.length
    const matchedLen = matchResult.usedFuzzyMatch
      ? normalizeForFuzzyMatch(edit.oldText, matchResult.fuzzyLevel >= 2).length
      : edit.oldText.length;

    matches.push({
      edit,
      index: matchResult.index,
      usedFuzzyMatch: matchResult.usedFuzzyMatch,
      matchedLen,
    });
  }

  // 4. 检测重叠：按位置排序后检查相邻 edit 是否交叉
  matches.sort((a, b) => a.index - b.index);

  for (let i = 0; i < matches.length - 1; i++) {
    const currentEnd = matches[i].index + matches[i].matchedLen;
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
    const { edit, index, matchedLen } = matches[i];
    result = result.slice(0, index) + edit.newText + result.slice(index + matchedLen);
  }

  // 6. 收集编辑位置（用于增量 diff）
  const editPositions = matches.map(m => ({
    oldCharStart: m.index,
    oldCharLen: m.matchedLen,
    newCharLen: m.edit.newText.length,
  }));

  return { baseContent: normalizedContent, newContent: result, editPositions, updatedHashInfo: [] };
}

// ============================================================
// 统一行级编辑（DSL 与 JSON 路径共用，从后往前应用）
// ============================================================

/** 第 idx 行（0-based）的起始字符偏移（含前面所有行的换行符） */
function lineStartOffset(lines: string[], idx: number): number {
  let off = 0;
  for (let i = 0; i < idx; i++) off += lines[i].length + 1;
  return off;
}

/**
 * 应用一批行级编辑（统一模型 LineEdit）。
 *
 * 核心保证：
 *   1. 行号/哈希基于**原始文件**验证（JSON 路径带 hashes，DSL 无）
 *   2. 按影响位置**从后往前**应用——靠后的编辑先做，靠前编辑的行号与
 *      字符偏移不受其影响（P0-1 修复的正确策略，DSL/JSON 单一路径）
 *   3. editPositions 按 oldCharStart 升序返回（增量 diff 需要）
 */
export function applyLineEdits(
  normalizedContent: string,
  edits: LineEdit[],
  filePath: string,
): AppliedEditsResult {
  if (edits.length === 0) {
    return { baseContent: normalizedContent, newContent: normalizedContent, editPositions: [], updatedHashInfo: [] };
  }
  const lines = normalizedContent.split('\n');
  const total = lines.length;

  // ── 1. 行号范围 + 哈希验证（基于原始行） ──
  for (const e of edits) {
    switch (e.kind) {
      case 'replace': {
        const si = e.startLine!, ei = e.endLine!;
        if (si < 1 || ei < si || ei > total) {
          throw new Error(`行级编辑 ${filePath}: 行 ${si}.=${ei} 超出范围（共 ${total} 行）。`);
        }
        const startHash = e.hashes?.start;
        const endHash = e.hashes?.end;
        if (startHash && hashLine(lines[si - 1]) !== startHash) {
          throw new Error(
            `Hashline 冲突：pos="${si}#${startHash}"，但第 ${si} 行当前哈希为 "${hashLine(lines[si - 1])}"。` +
            `文件可能已被并发修改，请重新 read 获取最新哈希。`
          );
        }
        if (endHash && hashLine(lines[ei - 1]) !== endHash) {
          throw new Error(
            `Hashline 冲突：end="${ei}#${endHash}"，但第 ${ei} 行当前哈希为 "${hashLine(lines[ei - 1])}"。` +
            `文件可能已被并发修改，请重新 read 获取最新哈希。`
          );
        }
        break;
      }
      case 'insert-before':
      case 'insert-after': {
        const anchor = e.anchorLine!;
        if (anchor < 1 || anchor > total) {
          throw new Error(`行级编辑 ${filePath}: 锚点行 ${anchor} 超出范围（共 ${total} 行）。`);
        }
        const anchorHash = e.hashes?.anchor;
        if (anchorHash && hashLine(lines[anchor - 1]) !== anchorHash) {
          throw new Error(
            `Hashline 冲突：pos="${anchor}#${anchorHash}"，但第 ${anchor} 行当前哈希为 "${hashLine(lines[anchor - 1])}"。` +
            `文件可能已被并发修改，请重新 read 获取最新哈希。`
          );
        }
        break;
      }
      default:
        break;
    }
  }

  // ── 2. 按影响位置从后往前排序（同位置按书写顺序逆序） ──
  const posOf = (e: LineEdit): number => {
    switch (e.kind) {
      case 'replace': return e.startLine!;
      case 'insert-before': return e.anchorLine!;
      case 'insert-after': return e.anchorLine! + 0.5; // 第 N 行后：位置在 N 与 N+1 之间
      case 'insert-start': return 0;
      case 'insert-end': return total + 1;
    }
  };
  const sorted = edits
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => (posOf(b.e) - posOf(a.e)) || (b.idx - a.idx));

  // ── 3. 从后往前应用（字符偏移基于 originalLines，靠前编辑不受后面影响） ──
  let result = normalizedContent;
  const editPositions: EditPosition[] = [];
  const updatedHashInfo: HashUpdateInfo[] = [];

  for (const { e } of sorted) {
    const newText = e.lines.join('\n');
    switch (e.kind) {
      case 'replace': {
        const si = e.startLine! - 1, ei = e.endLine! - 1;
        const start = lineStartOffset(lines, si);
        // end = 第 ei 行结束（含其行尾换行符）；最后一行无尾换行时取全文末尾
        let end = lineStartOffset(lines, ei + 1);
        if (ei === total - 1 && !normalizedContent.endsWith('\n')) end = normalizedContent.length;
        const oldLen = end - start;
        // 被替换区间含行尾换行符 → 若区间后仍有内容、且新内容非空且不以换行结尾，补换行分隔
        //（新内容为空 = 删除行：直接移除区间，前后行由区间边界保持分隔，不额外补行）
        const suffix = result.slice(end);
        const needTrailingNL = suffix.length > 0 && newText !== '' && !newText.endsWith('\n');
        result = result.slice(0, start)
          + newText
          + (needTrailingNL ? '\n' : '')
          + suffix;
        editPositions.push({
          oldCharStart: start,
          oldCharLen: oldLen,
          newCharLen: newText.length + (needTrailingNL ? 1 : 0),
        });
        updatedHashInfo.push({ oldHash: e.hashes?.start ?? hashLine(lines[si]), newHashes: e.lines.map(hashLine) });
        break;
      }
      case 'insert-before': {
        const idx = e.anchorLine! - 1;
        const start = lineStartOffset(lines, idx);
        result = result.slice(0, start) + newText + '\n' + result.slice(start);
        editPositions.push({ oldCharStart: start, oldCharLen: 0, newCharLen: newText.length + 1 });
        updatedHashInfo.push({ oldHash: e.hashes?.anchor ?? hashLine(lines[idx]), newHashes: e.lines.map(hashLine) });
        break;
      }
      case 'insert-after': {
        const idx = e.anchorLine! - 1;
        // 第 idx 行之后（含其换行符）；最后一行无尾换行时取全文末尾
        let end = lineStartOffset(lines, idx + 1);
        if (idx === total - 1 && !normalizedContent.endsWith('\n')) end = normalizedContent.length;
        result = result.slice(0, end)
          + (end > 0 && result[end - 1] !== '\n' ? '\n' : '')
          + newText
          + (end < result.length ? '\n' : '')
          + result.slice(end);
        editPositions.push({
          oldCharStart: end,
          oldCharLen: 0,
          newCharLen: newText.length + (end > 0 && end < result.length ? 1 : 0),
        });
        updatedHashInfo.push({ oldHash: e.hashes?.anchor ?? hashLine(lines[idx]), newHashes: e.lines.map(hashLine) });
        break;
      }
      case 'insert-start': {
        result = newText + '\n' + result;
        editPositions.push({ oldCharStart: 0, oldCharLen: 0, newCharLen: newText.length + 1 });
        updatedHashInfo.push({ oldHash: '(bof)', newHashes: e.lines.map(hashLine) });
        break;
      }
      case 'insert-end': {
        const end = result.length;
        result = result + (end > 0 && !result.endsWith('\n') ? '\n' : '') + newText;
        editPositions.push({
          oldCharStart: end,
          oldCharLen: 0,
          newCharLen: newText.length + (end > 0 && !result.endsWith('\n') ? 1 : 0),
        });
        updatedHashInfo.push({ oldHash: '(eof)', newHashes: e.lines.map(hashLine) });
        break;
      }
    }
  }

  // 增量 diff 需要按 oldCharStart 升序
  editPositions.sort((a, b) => a.oldCharStart - b.oldCharStart);

  return { baseContent: normalizedContent, newContent: result, editPositions, updatedHashInfo };
}
