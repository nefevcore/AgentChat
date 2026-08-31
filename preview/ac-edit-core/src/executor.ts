// ============================================================
// ac-edit-core/src/executor.ts —— edit 统一执行管线（src 原样继承，路径外置）
//
// 管线：读 → stripBom → 检测行尾 → 归一化 LF → old_string 文本匹配
//   → diff（增量/兜底全量）→ 写回（混合换行按行保留行尾）。
// 路径解析（沙箱校验）归调用方——本库零策略。
// ============================================================

import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  restoreLineEndingsPreserving,
  stripBom,
} from './line-ending.ts';
import { applyEditsToNormalizedContent } from './apply.ts';
import { generateDiffString, generateIncrementalDiff } from './diff.ts';
import { withFileMutationQueue } from './mutation-queue.ts';
import type { ReplaceEdit } from './types.ts';

/** 一次编辑批次：old_string 文本匹配编辑列表（单文件） */
export interface EditBatch {
  textEdits: ReplaceEdit[];
}

export interface EditBatchResult {
  diff: string;
  firstChangedLine: number | undefined;
  fuzzyMatches: number;
}

/**
 * 执行一次编辑批次（统一管线；同一文件经突变队列串行化）。
 *
 * 步骤：
 *   1. 读文件 → stripBom → 检测行尾 → 归一化 LF
 *   2. old_string 文本匹配（唯一性校验 + 三级模糊归一化）
 *   3. diff 生成（增量 / 兜底全量）
 *   4. 写回（混合换行按行保留行尾）
 */
export async function applyEditBatch(filePath: string, batch: EditBatch): Promise<EditBatchResult> {
  return withFileMutationQueue(filePath, async () => {
    // 1. 读文件 + 归一化
    try {
      await fs.access(filePath, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`文件不存在: ${path.basename(filePath)}。如需创建新文件请使用 write 工具。`);
    }
    const buffer = await fs.readFile(filePath);
    const rawContent = buffer.toString('utf-8'); // 保留原始（含 BOM/行尾），混合换行按行恢复用
    const content = stripBom(rawContent);
    const lineEnding = detectLineEnding(content);
    const normalized = normalizeToLF(content);

    // 2. 文本匹配编辑
    const r = applyEditsToNormalizedContent(normalized, batch.textEdits, filePath);
    const currentContent = r.newContent;
    const editPositions = r.editPositions;

    // 3. diff 生成
    const { diff, firstChangedLine } =
      editPositions.length === 0
        ? generateDiffString(normalized, currentContent)
        : generateIncrementalDiff(normalized, currentContent, editPositions);

    // 4. 写回（混合换行按行保留行尾）
    const finalContent =
      lineEnding === 'mixed'
        ? restoreLineEndingsPreserving(rawContent, currentContent)
        : restoreLineEndings(currentContent, lineEnding);
    await fs.writeFile(filePath, finalContent, 'utf-8');

    // fuzzy 统计（精确 includes 未命中即用了模糊归一化）
    const fuzzyMatches = batch.textEdits.filter((e) => !normalized.includes(e.oldText)).length;

    return { diff, firstChangedLine, fuzzyMatches };
  });
}
