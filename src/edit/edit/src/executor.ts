// ============================================================
// executor.ts —— edit 工具统一执行管线
//
// 2026-08-20 简化：edit 收敛为 old_string/new_string 文本匹配单一形态。
// 此前的 DSL TAG 验证 / 行级定位解析 / 行哈希校验 / 快照同步已删除，
// 管线只剩：读 → 归一化 → 文本替换 → diff → 写回（行尾保留）。
//
// 依赖方向：apply / diff / line-ending / file-mutation-queue。
// ============================================================

import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import type { AgentConfig } from '@agentchat/agent-config';
import { resolveSafePath } from '@agentchat/toolkit';
import {
  stripBom, detectLineEnding, normalizeToLF, restoreLineEndings, restoreLineEndingsPreserving,
} from './line-ending';
import { applyEditsToNormalizedContent } from './apply';
import { generateIncrementalDiff, generateDiffString } from './diff';
import { withFileMutationQueue } from './file-mutation-queue';
import type { ReplaceEdit } from './types';

// ============================================================
// 可插拔 I/O 接口（便于测试和远程编辑场景）
// ============================================================

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

export const defaultEditOperations: EditOperations = {
  readFile: (p) => fs.readFile(p),
  writeFile: (p, content) => fs.writeFile(p, content, 'utf-8'),
  access: (p) => fs.access(p, constants.R_OK | constants.W_OK),
};

// ============================================================
// 统一管线
// ============================================================

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
 * 执行一次编辑批次（统一管线）。
 *
 * 步骤：
 *   1. 读文件 → stripBom → 检测行尾 → 归一化 LF
 *   2. old_string 文本匹配（唯一性校验 + 三级模糊归一化）
 *   3. diff 生成（增量 / 兜底全量）
 *   4. 写回（混合换行按行保留行尾）
 */
export async function applyEditBatch(
  config: AgentConfig,
  filePath: string,
  batch: EditBatch,
  ops: EditOperations = defaultEditOperations,
): Promise<EditBatchResult> {
  const safePath = resolveSafePath(config, filePath);

  return withFileMutationQueue(safePath, async () => {
    // 1. 读文件 + 归一化
    try {
      await ops.access(safePath);
    } catch {
      throw new Error(`文件不存在: ${path.basename(safePath)}。如需创建新文件请使用 write 工具。`);
    }
    const buffer = await ops.readFile(safePath);
    const rawContent = buffer.toString('utf-8'); // 保留原始（含 BOM/行尾），混合换行按行恢复用
    const content = stripBom(rawContent);
    const lineEnding = detectLineEnding(content);
    const normalized = normalizeToLF(content);

    // 2. 文本匹配编辑
    const r = applyEditsToNormalizedContent(normalized, batch.textEdits, filePath);
    const currentContent = r.newContent;
    const editPositions = r.editPositions;

    // 3. diff 生成
    const { diff, firstChangedLine } = editPositions.length === 0
      ? generateDiffString(normalized, currentContent)
      : generateIncrementalDiff(normalized, currentContent, editPositions);

    // 4. 写回（混合换行按行保留行尾）
    const finalContent = lineEnding === 'mixed'
      ? restoreLineEndingsPreserving(rawContent, currentContent)
      : restoreLineEndings(currentContent, lineEnding);
    await ops.writeFile(safePath, finalContent);

    // fuzzy 统计（精确 includes 未命中即用了模糊归一化）
    const fuzzyMatches = batch.textEdits.filter(e => !normalized.includes(e.oldText)).length;

    return { diff, firstChangedLine, fuzzyMatches };
  });
}
