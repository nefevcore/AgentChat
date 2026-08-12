// ============================================================
// hashline-executor.ts —— Hashline DSL patch 执行器
//
// 流程：解析 DSL → 验证 TAG → 应用操作 → 更新快照 → 返回 diff。
// 与 JSON edit 流水线共享 BOM/行尾归一化逻辑。
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafePath } from '../shared';
import type { AgentConfig } from '@agents/config';
import {
  stripBom, detectLineEnding, normalizeToLF, restoreLineEndings, restoreLineEndingsPreserving,
  generateDiffString, type LineEnding,
} from './edit-diff';
import { withFileMutationQueue } from './file-mutation-queue';
import { parseHashlinePatch, type HashlineSection, type HashlineOp } from './hashline-parser';
import { computeFileHash } from '../shared';
import { verifySnapshot, updateSnapshot } from './hashline-snapshot';

// ── 文件前导：读取 + BOM + 归一化 ──

async function readAndNormalize(safePath: string): Promise<{
  content: string;
  rawContent: string;
  lineEnding: LineEnding;
}> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(safePath, 'utf-8');
  } catch {
    throw new Error(`文件不存在: ${path.basename(safePath)}。如需创建新文件请使用 write 工具。`);
  }
  const content = stripBom(rawContent);
  const lineEnding = detectLineEnding(content);
  return { content: normalizeToLF(content), rawContent, lineEnding };
}

// ── 单节操作应用 ──

/**
 * 从后往前应用 ops（按影响位置降序），保证多 op 用原始行号不错位——
 * 与 JSON 路径 applyHashBasedEdits 的策略一致。
 *
 * 根因（2026-08-12 审计 P0-1）：此前按书写顺序从前向后应用，
 * 第一个 op 改变行数后，后续 op 仍用原始行号操作已修改的 result → 静默改错位置。
 * 从后往前：靠后的 op 先应用，靠前 op 的行号不受其影响。
 */
function applyOps(content: string, ops: HashlineSection['ops'], originalLines: string[]): string {
  let result = content;
  const total = originalLines.length;

  // 操作的影响位置（1-based 行号；位置大的先应用）
  const posOf = (op: HashlineOp): number => {
    switch (op.kind) {
      case 'swap': return op.startLine;
      case 'ins_pre': return op.anchorLine;
      case 'ins_post': return op.anchorLine;
      case 'ins_head': return 0;
      case 'ins_tail': return total + 1;
      default: return 0;
    }
  };
  const sorted = ops
    .map((op, idx) => ({ op, idx }))
    .sort((a, b) => (posOf(b.op) - posOf(a.op)) || (b.idx - a.idx));

  for (const { op } of sorted) {
    switch (op.kind) {
      case 'swap': {
        const si = op.startLine - 1, ei = op.endLine - 1;
        if (si < 0 || ei >= total || si > ei) {
          throw new Error(`SWAP ${op.startLine}.=${op.endLine}: 行号超出范围（共 ${total} 行）。`);
        }
        const cur = result.split('\n');
        result = [...cur.slice(0, si), ...op.lines, ...cur.slice(ei + 1)].join('\n');
        break;
      }
      case 'ins_pre': {
        const idx = op.anchorLine - 1;
        if (idx < 0 || idx > total) {
          throw new Error(`INS.PRE ${op.anchorLine}: 行号超出范围（共 ${total} 行）。`);
        }
        const cur = result.split('\n');
        result = [...cur.slice(0, idx), ...op.lines, ...cur.slice(idx)].join('\n');
        break;
      }
      case 'ins_post': {
        const idx = op.anchorLine;
        if (idx < 0 || idx > total) {
          throw new Error(`INS.POST ${op.anchorLine}: 行号超出范围（共 ${total} 行）。`);
        }
        const cur = result.split('\n');
        result = [...cur.slice(0, idx), ...op.lines, ...cur.slice(idx)].join('\n');
        break;
      }
      case 'ins_head':
        result = [...op.lines, ...result.split('\n')].join('\n');
        break;
      case 'ins_tail':
        result = [...result.split('\n'), ...op.lines].join('\n');
        break;
      // cut/paste 暂不实现
    }
  }
  return result;
}

// ── 主入口 ──

export async function executeHashlineDSL(config: AgentConfig, input: string, stream: any): Promise<string> {
  const sections = parseHashlinePatch(input);
  if (sections.length === 0) {
    throw new Error('未找到有效的 Hashline section。请以 [PATH#TAG] 开头。');
  }

  const results: any[] = [];

  for (const section of sections) {
    const safePath = resolveSafePath(config, section.path);
    stream?.onChunk?.(`正在编辑: ${section.path} (${section.ops.length} 处操作)...\n`);

    await withFileMutationQueue(safePath, async () => {
      const { content, rawContent, lineEnding } = await readAndNormalize(safePath);

      // TAG 验证
      if (section.tag && !verifySnapshot(safePath, section.tag, content)) {
        throw new Error(
          `Hashline TAG 不匹配："#${section.tag}" vs 当前 "#${computeFileHash(content)}"。` +
          `文件可能已被修改，请重新 read。`
        );
      }

      const originalLines = content.split('\n');
      const newContent = applyOps(content, section.ops, originalLines);

      // 写回（混合换行按行保留原始行尾，避免未编辑行被强制统一 → 整文件字节污染）
      const finalContent = lineEnding === 'mixed'
        ? restoreLineEndingsPreserving(rawContent, newContent)
        : restoreLineEndings(newContent, lineEnding);
      await fs.writeFile(safePath, finalContent, 'utf-8');
      updateSnapshot(safePath, newContent);

      const { diff, firstChangedLine } = generateDiffString(content, newContent);

      results.push({
        path: section.path,
        file: path.basename(section.path),
        ops_applied: section.ops.length,
        first_changed_line: firstChangedLine,
        diff,
      });
    });
  }

  return JSON.stringify({
    status: 'success',
    data: results.length === 1 ? results[0] : { files: results },
  });
}
