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
  repairDuplicatedCr,
  restoreLineEndings,
  restoreLineEndingsPreserving,
  stripBom,
} from './line-ending.ts';
import { applyEditsToNormalizedContent } from './apply.ts';
import { generateDiffString, generateIncrementalDiff } from './diff.ts';
import { syntaxCheckBeforeWrite } from './syntax-check.ts';
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
  /** 行级新增数（编辑区 `- ` 行；工具卡 Label +N 数据源） */
  diffAdded: number;
  /** 行级删除数（编辑区 `+ ` 行；工具卡 Label -M 数据源） */
  diffRemoved: number;
  /** 编辑落点核验回显（readback）：编辑区前后各 ~3 行，带行号（read 同款格式） */
  readback?: string;
  /** 读入时修复的 CR 双写行尾损伤处数（\r\r\n → \r\n；0/无损伤省略——2026-11-19 画像 Ⓑ） */
  repairedCr?: number;
}

/**
 * 执行一次编辑批次（统一管线；同一文件经突变队列串行化）。
 *
 * 步骤：
 *   1. 读文件 → stripBom → 检测行尾 → 归一化 LF
 *   2. old_string 文本匹配（唯一性交叉校验；Level 2 拒绝编辑）
 *   3. 语法预检（json/括号配平，失败拒绝写回、文件保持原状）
 *   4. diff 生成（增量 / 兜底全量）
 *   5. 写回（混合换行按行保留行尾）
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
    // 存量 CR 双写损伤修复（\r{2,}\n → \r\n）：既往事故的行尾损伤会让后续
    // 所有标准 CRLF old_string 失配——读入即修，一次损伤不再放大成连环失败
    // （2026-11-19 画像 Ⓑ 实锤：一次行尾损伤放大成 27 次失配）
    const { fixed: repairedContent, count: repairedCr } = repairDuplicatedCr(content);
    const lineEnding = detectLineEnding(repairedContent);
    const normalized = normalizeToLF(repairedContent);

    // 2. 文本匹配编辑（old/new 先入 LF 匹配空间——CR 双写源头治理：
    // 模型从 read 输出复制的文本常带 CRLF 行尾，原样混入会让精确匹配失配、
    // new_string 的 \r\n 经写回行尾恢复再叠一层 \r 产出 \r\r\n 双写）
    const textEdits: ReplaceEdit[] = batch.textEdits.map((e) => ({
      oldText: normalizeToLF(e.oldText),
      newText: normalizeToLF(e.newText),
    }));
    let r: ReturnType<typeof applyEditsToNormalizedContent>;
    try {
      r = applyEditsToNormalizedContent(normalized, textEdits, filePath);
    } catch (err: unknown) {
      // 失配诊断增强（画像 Ⓑ.2）：附文件与 old_string 的行尾形态统计——
      // 一行诊断顶十次盲试（old_string 行尾问题 vs 内容问题立判）
      if (err instanceof Error && err.message.includes('未找到 old_string')) {
        const olds = textEdits.map((e) => e.oldText).join('\n');
        throw new Error(
          `${err.message}\n行尾诊断：文件 ${describeLineEndings(normalized)}；old_string ${describeLineEndings(olds)}（edit 已自动把 CRLF 归一化为 LF 匹配，行尾不是失配原因——内容已变，须 read 重新对齐）`,
        );
      }
      throw err;
    }
    const currentContent = r.newContent;
    const editPositions = r.editPositions;

    // 3. 写回前语法预检（P1 fail-fast）：json/括号配平失败 → 拒绝编辑、文件保持原状。
    //    编辑前已损坏的文件放行（修复编辑不该被旧伤锁死——事故连环修复期的护栏）
    const syntax = syntaxCheckBeforeWrite(filePath, normalized, currentContent);
    if (syntax) {
      throw new Error(
        `编辑被拒绝（写回前语法预检）：${syntax.reason}\n` +
          `恢复建议：用 read 重新读取目标段落核对 old_string 落点；确认无误后可改用 write 整段重写。`,
      );
    }

    // 4. diff 生成
    const { diff, firstChangedLine, diffAdded, diffRemoved } =
      editPositions.length === 0
        ? generateDiffString(normalized, currentContent)
        : generateIncrementalDiff(normalized, currentContent, editPositions);

    // 5. 写回（混合换行按行保留行尾；修复后的原文为基准——行文本不含 CR 尾巴）
    const finalContent =
      lineEnding === 'mixed'
        ? restoreLineEndingsPreserving(repairedContent, currentContent)
        : restoreLineEndings(currentContent, lineEnding);
    // 写回终检：任何路径产出的 CR 双写形态在此归一（防御性保险，零成本）
    const { fixed: safeContent } = repairDuplicatedCr(finalContent);
    await fs.writeFile(filePath, safeContent, 'utf-8');

    // 6. readback 回显（P2）：编辑落点核验用，行号格式与 read 工具一致
    const readback =
      editPositions.length > 0
        ? renderReadback(currentContent, editPositions.map((p) => p.oldCharStart))
        : undefined;

    // fuzzy 统计（按实际生效的匹配级别：0=精确，1=归一化模糊）
    const fuzzyMatches = r.matchLevels.filter((lv) => lv >= 1).length;

    return {
      diff,
      firstChangedLine,
      fuzzyMatches,
      diffAdded,
      diffRemoved,
      readback,
      ...(repairedCr > 0 ? { repairedCr } : {}),
    };
  });
}

/** 行尾形态统计（失配诊断用）：CRLF / 纯 LF / 孤立 CR 各计数量 */
function describeLineEndings(s: string): string {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const loneCr = (s.match(/\r(?!\n)/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  return `CRLF=${crlf} LF=${lf} 孤立CR=${loneCr}`;
}

/** readback 渲染：编辑区前后各 ~3 行，`行号 文本`（与 read 工具输出同格式） */
function renderReadback(content: string, editStarts: number[]): string {
  const lines = content.split('\n');
  const breaks: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') breaks.push(i);
  }
  const charToLine = (charIndex: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < charIndex) lo = mid + 1;
      else hi = mid;
    }
    return lo; // 0-based
  };

  const RANGE = 3;
  const selected = new Set<number>();
  for (const start of editStarts) {
    const line = charToLine(start);
    for (let l = Math.max(0, line - RANGE); l <= Math.min(lines.length - 1, line + RANGE); l++) {
      selected.add(l);
    }
  }

  const out: string[] = [];
  let prev = -2;
  for (const l of Array.from(selected).sort((a, b) => a - b)) {
    if (l > prev + 1) out.push('...');
    out.push(`${l + 1} ${lines[l]}`);
    prev = l;
  }
  return out.join('\n');
}
