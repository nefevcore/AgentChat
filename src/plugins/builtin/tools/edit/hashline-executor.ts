// ============================================================
// hashline-executor.ts —— Hashline DSL patch 执行器
//
// 流程：解析 DSL → 验证 TAG → 应用操作 → 更新快照 → 返回 diff。
// 与 JSON edit 流水线共享 BOM/行尾归一化逻辑。
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafePath } from '@core/config';
import {
  stripBom, detectLineEnding, normalizeToLF, restoreLineEndings,
  generateDiffString,
} from './edit-diff';
import { withFileMutationQueue } from './file-mutation-queue';
import { parseHashlinePatch, type HashlineSection } from './hashline-parser';
import { computeFileHash } from '../shared';
import { verifySnapshot, updateSnapshot } from './hashline-snapshot';

// ── 文件前导：读取 + BOM + 归一化 ──

async function readAndNormalize(safePath: string): Promise<{
  content: string;
  lineEnding: '\r\n' | '\n';
}> {
  let content: string;
  try {
    content = await fs.readFile(safePath, 'utf-8');
  } catch {
    throw new Error(`文件不存在: ${path.basename(safePath)}。如需创建新文件请使用 write 工具。`);
  }
  content = stripBom(content);
  const lineEnding = detectLineEnding(content);
  return { content: normalizeToLF(content), lineEnding };
}

// ── 单节操作应用 ──

function applyOps(content: string, ops: HashlineSection['ops'], originalLines: string[]): string {
  let result = content;
  for (const op of ops) {
    switch (op.kind) {
      case 'swap': {
        const si = op.startLine - 1, ei = op.endLine - 1;
        if (si < 0 || ei >= originalLines.length || si > ei) {
          throw new Error(`SWAP ${op.startLine}.=${op.endLine}: 行号超出范围（共 ${originalLines.length} 行）。`);
        }
        const cur = result.split('\n');
        result = [...cur.slice(0, si), ...op.lines, ...cur.slice(ei + 1)].join('\n');
        break;
      }
      case 'ins_pre': {
        const idx = op.anchorLine - 1;
        if (idx < 0 || idx > originalLines.length) {
          throw new Error(`INS.PRE ${op.anchorLine}: 行号超出范围（共 ${originalLines.length} 行）。`);
        }
        const cur = result.split('\n');
        result = [...cur.slice(0, idx), ...op.lines, ...cur.slice(idx)].join('\n');
        break;
      }
      case 'ins_post': {
        const idx = op.anchorLine;
        if (idx < 0 || idx > originalLines.length) {
          throw new Error(`INS.POST ${op.anchorLine}: 行号超出范围（共 ${originalLines.length} 行）。`);
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

export async function executeHashlineDSL(input: string, stream: any): Promise<string> {
  const sections = parseHashlinePatch(input);
  if (sections.length === 0) {
    throw new Error('未找到有效的 Hashline section。请以 [PATH#TAG] 开头。');
  }

  const results: any[] = [];

  for (const section of sections) {
    const safePath = resolveSafePath(section.path);
    stream?.onChunk?.(`正在编辑: ${section.path} (${section.ops.length} 处操作)...\n`);

    await withFileMutationQueue(safePath, async () => {
      const { content, lineEnding } = await readAndNormalize(safePath);

      // TAG 验证
      if (section.tag && !verifySnapshot(safePath, section.tag, content)) {
        throw new Error(
          `Hashline TAG 不匹配："#${section.tag}" vs 当前 "#${computeFileHash(content)}"。` +
          `文件可能已被修改，请重新 read。`
        );
      }

      const originalLines = content.split('\n');
      const newContent = applyOps(content, section.ops, originalLines);

      // 写回
      await fs.writeFile(safePath, restoreLineEndings(newContent, lineEnding), 'utf-8');
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
