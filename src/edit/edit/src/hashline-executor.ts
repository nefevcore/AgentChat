// ============================================================
// hashline-executor.ts —— Hashline DSL patch 执行器（薄适配器）
//
// 2026-08-12 重构：DSL 与 JSON 两条路径统一走 executor.ts 的
// applyEditBatch 管线。本文件只负责把 DSL op 归一化为统一行级
// 编辑模型（LineEdit[]），并统一返回结构（edits_applied / file_tag）。
//
// 此前本文件承载 readAndNormalize/applyOps/写回/快照/报错 等全部逻辑，
// 现已收敛到统一管线（消除两条路径重复与 P0-1 类不一致根源）。
// ============================================================

import * as path from 'path';
import type { AgentConfig } from '@agentchat/agent-config';
import { parseHashlinePatch, type HashlineOp } from './hashline-parser';
import { applyEditBatch, defaultEditOperations } from './executor';
import type { LineEdit } from './types';

/** DSL op → 统一行级编辑模型（LineEdit） */
function opToLineEdit(op: HashlineOp): LineEdit {
  switch (op.kind) {
    case 'swap': return { kind: 'replace', startLine: op.startLine, endLine: op.endLine, lines: op.lines };
    case 'ins_pre': return { kind: 'insert-before', anchorLine: op.anchorLine, lines: op.lines };
    case 'ins_post': return { kind: 'insert-after', anchorLine: op.anchorLine, lines: op.lines };
    case 'ins_head': return { kind: 'insert-start', lines: op.lines };
    case 'ins_tail': return { kind: 'insert-end', lines: op.lines };
  }
}

// ── 主入口 ──

export async function executeHashlineDSL(config: AgentConfig, input: string, stream: any): Promise<string> {
  const sections = parseHashlinePatch(input);
  if (sections.length === 0) {
    throw new Error('未找到有效的 Hashline section。请以 [PATH#TAG] 开头。');
  }

  const results: any[] = [];

  for (const section of sections) {
    stream?.onChunk?.(`正在编辑: ${section.path} (${section.ops.length} 处操作)...\n`);

    const lineEdits = section.ops.map(opToLineEdit);
    const { diff, firstChangedLine, fuzzyMatches, updatedHashInfo, fileTag } = await applyEditBatch(
      config,
      section.path,
      { tag: section.tag, lineEdits, textEdits: [] },
      defaultEditOperations,
    );

    results.push({
      path: section.path,
      file: path.basename(section.path),
      edits_applied: lineEdits.length,
      fuzzy_matches: fuzzyMatches,
      updated_hashes: updatedHashInfo.map(h => ({ old_hash: h.oldHash, new_hashes: h.newHashes })),
      file_tag: fileTag,
      first_changed_line: firstChangedLine,
      diff,
    });
  }

  return JSON.stringify({
    status: 'success',
    data: results.length === 1 ? results[0] : { files: results },
  });
}
