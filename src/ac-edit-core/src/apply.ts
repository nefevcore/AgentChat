// ============================================================
// ac-edit-core/src/apply.ts —— 编辑应用（src edit 原样继承，路径解析外置）
//
// 2026-08-20 src 收敛后的形态：old_string/new_string 文本匹配单一形态。
// 与 src executor 的差异：不含 AgentConfig/resolveSafePath——
// 沙箱路径解析归调用方（ac-fs-tools 先解析再进本管线，
// 解除 src toolkit→agent-config 依赖倒挂，地图 §3.4）。
// ============================================================

import { countOccurrences, fuzzyFindText, normalizeForFuzzyMatch } from './fuzzy-match.ts';
import type { AppliedEditsResult, EditPosition, FuzzyMatchResult, ReplaceEdit } from './types.ts';

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
    return { baseContent: normalizedContent, newContent: normalizedContent, editPositions: [] };
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
      throw new Error('编辑失败：old_string 不能为空。请提供要替换的精确文本。');
    }

    // 2. 在归一化后的内容中查找
    const matchResult: FuzzyMatchResult = fuzzyFindText(normalizedContent, edit.oldText);

    if (!matchResult.found) {
      throw new Error(
        `在 "${filePath}" 中未找到 old_string。` +
          `old_string 必须与文件内容匹配（引号/空白差异可自动归一化）。` +
          `\n未找到的文本："""\n${edit.oldText.slice(0, 300)}"""` +
          (edit.oldText.length > 300 ? '\n...（已截断）' : '') +
          `\n恢复建议：先用 read 查看该文件当前内容，从输出复制精确原文；old_string 尽量短而独特（避免空白/换行差异）。`,
      );
    }

    // 3. 检查唯一性：统计 oldText 在原内容中的出现次数
    const occurrences = countOccurrences(
      matchResult.usedFuzzyMatch
        ? matchResult.fuzzyLevel >= 2
          ? normalizeForFuzzyMatch(normalizedContent, true)
          : normalizeForFuzzyMatch(normalizedContent, false)
        : normalizedContent,
      edit.oldText,
      matchResult.usedFuzzyMatch,
      matchResult.fuzzyLevel,
    );

    if (occurrences > 1) {
      throw new Error(
        `在 "${filePath}" 中 old_string 出现了 ${occurrences} 次。` +
          `old_string 必须唯一。请提供更多上下文使其唯一。` +
          `\n重复文本："""\n${edit.oldText.slice(0, 300)}"""` +
          (edit.oldText.length > 300 ? '\n...（已截断）' : '') +
          `\n恢复建议：在 old_string 中多包含前后几行内容，让目标位置独一无二。`,
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
          `请确保每个 old_string 匹配的内容在文件中不互相交叉。`,
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
  const editPositions: EditPosition[] = matches.map((m) => ({
    oldCharStart: m.index,
    oldCharLen: m.matchedLen,
    newCharLen: m.edit.newText.length,
  }));

  return { baseContent: normalizedContent, newContent: result, editPositions };
}
