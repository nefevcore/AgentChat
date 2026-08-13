// ============================================================
// executor.ts —— edit 工具统一执行管线
//
// 2026-08-12 重构：DSL 与 JSON 两条路径此前各自实现
// 「读 → 归一化 → 验证 → 应用 → diff → 写回 → 快照」，
// 是 P0-1 类"两条路径策略不一致" bug 的根本来源。
// 本文件收敛为单一管线 applyEditBatch，两条路径只负责把各自的
// 输入归一化为 LineEdit[]（统一行级模型）+ ReplaceEdit[]，共用此管线。
//
// 依赖方向：apply / diff / line-ending / hashline-snapshot / file-mutation-queue。
// ============================================================

import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import type { AgentConfig } from '@agents/config';
import { resolveSafePath } from '../shared';
import { hashLine } from '../shared';
import {
  stripBom, detectLineEnding, normalizeToLF, restoreLineEndings, restoreLineEndingsPreserving,
} from './line-ending';
import { applyEditsToNormalizedContent, applyLineEdits } from './apply';
import { generateIncrementalDiff, generateDiffString } from './diff';
import { verifySnapshotDetailed, updateSnapshot, getSnapshot } from './hashline-snapshot';
import { withFileMutationQueue } from './file-mutation-queue';
import type { LineEdit, ReplaceEdit, EditPosition, HashUpdateInfo } from './types';

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

/** 一次编辑批次的输入：行级编辑（统一模型）+ 可选文本编辑 + 可选文件 TAG 验证 */
export interface EditBatch {
  /** 文件级 TAG 验证（DSL 路径；JSON 路径用行哈希验证，不传） */
  tag?: string;
  /** 行级编辑（统一模型，从后往前应用） */
  lineEdits: LineEdit[];
  /** oldText 文本匹配编辑（最后执行） */
  textEdits: ReplaceEdit[];
}

export interface EditBatchResult {
  diff: string;
  firstChangedLine: number | undefined;
  fuzzyMatches: number;
  updatedHashInfo: HashUpdateInfo[];
  /** 编辑后的新文件 TAG（供 Agent 下次 DSL edit 直接使用，无需重新 read） */
  fileTag: string;
}

/**
 * 执行一次编辑批次（统一管线）。
 *
 * 步骤：
 *   1. 读文件 → stripBom → 检测行尾 → 归一化 LF
 *   2. TAG 验证（DSL：文件级版本校验，含详细失败诊断）
 *   3. 定位解析：裸行号（从快照取哈希）+ 纯哈希（从文件内容解析行号）
 *   4. 行级编辑（applyLineEdits，统一从后往前 + 行哈希验证）
 *   5. oldText 文本匹配（最后执行，不受行号影响）
 *   6. diff 生成（增量 / 混合兜底全量）
 *   7. 写回（混合换行按行保留行尾）+ 同步快照
 *   8. 返回统一结果（diff / fuzzy / updated_hashes / file_tag）
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

    // 2. TAG 验证（DSL：文件级版本校验，详细诊断区分失败原因）
    if (batch.tag) {
      const v = verifySnapshotDetailed(safePath, batch.tag, normalized);
      if (!v.ok) {
        const msg = v.reason === 'no-snapshot'
          ? `Hashline TAG 不匹配：请求 "#${batch.tag}"，但未找到 read 快照且磁盘当前哈希为 "#${v.diskHash}"。请先 read 获取最新 [PATH#TAG] 再编辑。`
          : v.reason === 'snapshot-mismatch'
            ? `Hashline TAG 不匹配：请求 "#${batch.tag}" 与 read 快照 "#${v.snapshotTag}" 不一致——文件自 read 后被 write/改写（快照未同步）。请重新 read 获取最新 TAG。`
            : `Hashline TAG 不匹配：请求 "#${batch.tag}" 与磁盘当前哈希 "#${v.diskHash}" 不一致——文件自 read 后被外部修改。请重新 read。`;
        throw new Error(msg);
      }
    }

    // 3. 定位解析：裸行号 → 快照哈希；纯哈希（lineHashOnly）→ 文件内容解析行号
    //    前置：清理行尾 \r（CRLF 输入的 DSL body / 编辑内容可能带 \r 残留）
    for (const e of batch.lineEdits) {
      if (e.lines.some(l => l.endsWith('\r'))) {
        e.lines = e.lines.map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
      }
    }
    resolvePositions(safePath, normalized, batch.lineEdits, filePath);

    // 4. 行级编辑（统一从后往前）
    const lineResult = applyLineEdits(normalized, batch.lineEdits, filePath);
    let currentContent = lineResult.newContent;
    const editPositions: EditPosition[] = [...lineResult.editPositions];
    const updatedHashInfo: HashUpdateInfo[] = [...lineResult.updatedHashInfo];

    // 5. oldText 文本匹配（最后执行，不受行号影响）
    if (batch.textEdits.length > 0) {
      const r = applyEditsToNormalizedContent(currentContent, batch.textEdits, filePath);
      currentContent = r.newContent;
      editPositions.push(...r.editPositions);
    }

    // 6. diff 生成
    const hasStructural = batch.lineEdits.length > 0;
    const isMixed = hasStructural && batch.textEdits.length > 0;
    const { diff, firstChangedLine } = isMixed || editPositions.length === 0
      ? generateDiffString(normalized, currentContent)
      : generateIncrementalDiff(normalized, currentContent, editPositions);

    // 7. 写回（混合换行按行保留行尾）+ 同步快照
    const finalContent = lineEnding === 'mixed'
      ? restoreLineEndingsPreserving(rawContent, currentContent)
      : restoreLineEndings(currentContent, lineEnding);
    await ops.writeFile(safePath, finalContent);
    const fileTag = updateSnapshot(safePath, currentContent);

    // 8. fuzzy 统计（仅 oldText 编辑）
    const fuzzyMatches = batch.textEdits.filter(e => !normalized.includes(e.oldText)).length;

    return { diff, firstChangedLine, fuzzyMatches, updatedHashInfo, fileTag };
  });
}

/**
 * 定位解析（在拿到归一化内容后）：
 *   · 裸行号（hash 为空串）→ 从 read 快照取期望哈希
 *   · 纯哈希定位（lineHashOnly）→ 从文件内容哈希表解析行号
 */
function resolvePositions(safePath: string, normalized: string, edits: LineEdit[], filePath: string): void {
  const lines = normalized.split('\n');
  const hashToLine = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const h = hashLine(lines[i]);
    if (!hashToLine.has(h)) hashToLine.set(h, i + 1); // 1-based，重复取首次
  }

  for (const e of edits) {
    if (e.kind !== 'replace' && e.kind !== 'insert-before' && e.kind !== 'insert-after') continue;

    // 纯哈希定位（兼容旧 lineHash，无行号）→ 解析行号
    if (e.kind === 'replace' && e.lineHashOnly && !e.startLine) {
      const ln = hashToLine.get(e.lineHashOnly);
      if (ln === undefined) {
        throw new Error(
          `在 "${filePath}" 中未找到 lineHash="${e.lineHashOnly}"。` +
          `文件内容可能已被修改，请重新 read 获取最新哈希。`
        );
      }
      e.startLine = ln;
      e.endLine = ln;
      e.hashes = { ...(e.hashes ?? {}), start: e.lineHashOnly };
      continue;
    }

    // 裸行号（hash 为空串）→ 从 read 快照解析期望哈希
    const hashes = e.hashes ?? {};
    const resolveSnap = (lineNum: number) => {
      const snapshot = getSnapshot(safePath);
      if (!snapshot) {
        throw new Error(`无法定位行号：未找到 "${safePath}" 的 read 快照。请先 read 获取 [PATH#TAG] 头部与行号，再编辑。`);
      }
      const snapLines = snapshot.content.split('\n');
      const idx = lineNum - 1;
      if (idx < 0 || idx >= snapLines.length) {
        throw new Error(`行号 ${lineNum} 超出 read 时文件范围（共 ${snapLines.length} 行）。请重新 read。`);
      }
      return hashLine(snapLines[idx]);
    };
    if (e.kind === 'replace') {
      if (hashes.start === '') hashes.start = resolveSnap(e.startLine!);
      if (hashes.end === '') hashes.end = resolveSnap(e.endLine!);
    } else if (hashes.anchor === '') {
      hashes.anchor = resolveSnap(e.anchorLine!);
    }
  }
}
