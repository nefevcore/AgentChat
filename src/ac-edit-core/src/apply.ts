// ============================================================
// ac-edit-core/src/apply.ts —— 编辑应用（src edit 原样继承，路径解析外置）
//
// 2026-08-20 src 收敛后的形态：old_string/new_string 文本匹配单一形态。
// 与 src executor 的差异：不含 AgentConfig/resolveSafePath——
// 沙箱路径解析归调用方（ac-fs-tools 先解析再进本管线，
// 解除 src toolkit→agent-config 依赖倒挂，地图 §3.4）。
// ============================================================

import { countOccurrencesByLevel, fuzzyFindText, normalizeForFuzzyMatch } from './fuzzy-match.ts';
import type { AppliedEditsResult, EditMatchLevel, EditPosition, FuzzyMatchResult, ReplaceEdit } from './types.ts';

/**
 * 对归一化后的内容执行多个精确替换。
 *
 * 验证规则（P0 匹配语义收口，事故背景 docs/edit-tool-incident-report.md）：
 *   1. oldText 不能为空；oldText === newText 时拒绝（无变化的编辑没有任何
 *      效果，只会白白写盘、拍快照、碰 mtime——多半是模型笔误，写错一侧了）
 *   2. 仅 Level 0/1 可落编辑（Level 1 = NFKC + trimEnd + 引号/破折号归一化，
 *      覆盖 Unicode 噪声主场景）；Level 2（trim 行首空白）只定位不替换——
 *      行首缩进是代码语义的一部分，trim 归一化在重复文本文件里错位率过高
 *   3. 唯一性按最宽松级别交叉校验：lenientCount > 1 即拒绝（归一化空间里
 *      与多处文本趋同的 old_string 不可信），不再只在选定级别内计数
 *   4. 多个 edit 的匹配范围不能重叠
 *
 * 替换策略：从后往前替换，保证前面的偏移量不变。
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: ReplaceEdit[],
  filePath: string,
): AppliedEditsResult {
  if (edits.length === 0) {
    return { baseContent: normalizedContent, newContent: normalizedContent, editPositions: [], matchLevels: [] };
  }

  // 每个 edit 的匹配信息
  interface EditMatch {
    edit: ReplaceEdit;
    index: number;
    usedFuzzyMatch: boolean;
    /** 在原始 content 中实际匹配到的文本长度（≠ edit.oldText.length 当 fuzzy trimEnd 截短时） */
    matchedLen: number;
    /** 实际生效的匹配级别（0/1；2 不会出现在这里——只定位不替换） */
    matchLevel: EditMatchLevel;
  }

  const matches: EditMatch[] = [];

  for (const edit of edits) {
    // 1. oldText 不能为空；oldText === newText 无变化拒绝
    if (edit.oldText.length === 0) {
      throw new Error('编辑失败：old_string 不能为空。请提供要替换的精确文本。');
    }
    if (edit.oldText === edit.newText) {
      throw new Error(
        `编辑被拒绝：new_string 与 old_string 完全相同，替换后文件不会有任何变化。` +
          `\n多半是笔误（写错了其中一侧）：请核对待修改的文本，` +
          `new_string 填替换后的完整新文本（含希望保留的部分）。`,
      );
    }

    // 2. 三级查找（Level 0 精确 → Level 1 trimEnd → Level 2 trim 仅定位）
    const matchResult: FuzzyMatchResult = fuzzyFindText(normalizedContent, edit.oldText);

    if (!matchResult.found) {
      throw new Error(
        `在 "${filePath}" 中未找到 old_string（精确与归一化匹配均未命中）。` +
          `\n未找到的文本："""\n${edit.oldText.slice(0, 300)}"""` +
          (edit.oldText.length > 300 ? '\n...（已截断）' : '') +
          `\n恢复建议：用 read 重新读取该文件当前内容，从输出原样复制目标段落（连续编辑同一文件时，上一次编辑的产物 ≠ 记忆中的文本，old_string 必须重新 read 获取）。`,
      );
    }

    // 3. Level 2 只定位不替换：行首缩进是代码语义的一部分，trim 归一化
    //    在重复文本场景下错位率过高（事故第 5 次 edit 即此路径静默错位）
    if (matchResult.fuzzyLevel === 2) {
      throw new Error(
        `编辑被拒绝：old_string 与文件内容仅在不区分行首缩进的归一化后匹配（fuzzy level 2），不允许模糊替换。` +
          `\n模糊命中的文本："""\n${edit.oldText.slice(0, 300)}"""` +
          (edit.oldText.length > 300 ? '\n...（已截断）' : '') +
          `\n恢复建议：用 read 重新读取目标段落，原样复制含缩进的原文后重试。`,
      );
    }

    // 4. 唯一性交叉校验：按最宽松级别（trim 全归一化）计数——归一化空间里
    //    与多处文本趋同的 old_string 不可信（含「扩大上下文会把更多重复内容
    //    包进来、越改越不唯一」的场景）
    const { exactCount, strictCount, lenientCount } = countOccurrencesByLevel(normalizedContent, edit.oldText);
    const counts = [exactCount, strictCount, lenientCount];
    const maxCount = Math.max(...counts);

    if (maxCount > 1) {
      const levelName =
        exactCount === maxCount ? '精确' : strictCount === maxCount ? '归一化（trimEnd）' : '全归一化（trim）';
      throw new Error(
        `在 "${filePath}" 中 old_string 有歧义：${levelName}形态下出现 ${maxCount} 次（精确 ${exactCount} / 归一化 ${strictCount} / 全归一化 ${lenientCount}）。` +
          `\n重复文本："""\n${edit.oldText.slice(0, 300)}"""` +
          (edit.oldText.length > 300 ? '\n...（已截断）' : '') +
          `\n恢复建议：归一化后与多处文本趋同，扩大 old_string 上下文可能把更多重复内容包进来；文件存在同前缀重复文本块时，改用 write 整段重写或命令行行级操作。`,
      );
    }

    // 计算匹配文本在原始 content 中的实际长度
    // 模糊匹配 trimEnd 会截短 oldText，所以 matchedLen < edit.oldText.length
    const matchedLen = matchResult.usedFuzzyMatch
      ? normalizeForFuzzyMatch(edit.oldText, false).length
      : edit.oldText.length;

    matches.push({
      edit,
      index: matchResult.index,
      usedFuzzyMatch: matchResult.usedFuzzyMatch,
      matchedLen,
      matchLevel: matchResult.fuzzyLevel as EditMatchLevel,
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

  // 6. 收集编辑位置（用于增量 diff）与匹配级别
  const editPositions: EditPosition[] = matches.map((m) => ({
    oldCharStart: m.index,
    oldCharLen: m.matchedLen,
    newCharLen: m.edit.newText.length,
  }));

  return {
    baseContent: normalizedContent,
    newContent: result,
    editPositions,
    matchLevels: matches.map((m) => m.matchLevel),
  };
}
