// ============================================================
// edit 工具 —— Hashline 内容哈希编辑协议 v2
//
// 支持两种输入模式：
//
// 1. Hashline DSL（推荐，token 效率最高）：
//    { input: "[path#a1b2]\nSWAP 2.=3:\n+新行2\n+新行3" }
//    参考 oh-my-pi 的 patch 语言
//
// 2. JSON edits（兼容旧格式）：
//    { edits: [{ filePath, op, pos, newText }] }
//
// v2 改进（文件级哈希 + 快照验证）：
//   - read 返回 [PATH#TAG] 头部 → edit 用 TAG 验证文件版本
//   - SWAP/INS.PRE/INS.POST/INS.HEAD/INS.TAIL 操作
//   - 纯行号定位（文件哈希已验证一致性）
// ============================================================

import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import { Tool } from '@core/types';
import { meta } from './meta';
import { getGlobalConfig, resolveSafePath } from '@core/config';
import {
  type ReplaceEdit,
  type HashEdit,
  type AppendEdit,
  type PrependEdit,
  type RangeEdit,
  type EditPosition,
  type HashUpdateInfo,
  stripBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  applyEditsToNormalizedContent,
  applyHashBasedEdits,
  applyAppendEdits,
  applyPrependEdits,
  applyRangeEdits,
  generateIncrementalDiff,
  generateDiffString,
} from './edit-diff';
import { withFileMutationQueue } from './file-mutation-queue';
import {
  type HashlineSection,
  type HashlineOp,
  parseHashlinePatch,
  computeFileHash,
} from '../shared';
import { verifySnapshot, updateSnapshot } from './hashline-snapshot';

// ============================================================
// 路径安全（使用共享工具，支持路径白名单）
// ============================================================

// ============================================================
// 可插拔 I/O 接口（便于测试和远程编辑场景）
// ============================================================

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (p) => fs.readFile(p),
  writeFile: (p, content) => fs.writeFile(p, content, 'utf-8'),
  access: (p) => fs.access(p, constants.R_OK | constants.W_OK),
};

// ============================================================
// Legacy API 兼容：oldString/newString → edits[]
// ============================================================

interface LegacyEditArgs {
  filePath?: string;
  oldString?: string;
  newString?: string;
  edits?: ReplaceEdit[];
  [key: string]: unknown;
}

// ── 文件级编辑分组 ──
interface FileEditGroup {
  filePath: string;
  edits: ReplaceEdit[];
  hashEdits: HashEdit[];
  appendEdits: AppendEdit[];
  prependEdits: PrependEdit[];
  rangeEdits: RangeEdit[];
}

/**
 * 新格式：{ edits: [{ filePath, op?, pos?, end?, newText }] }
 * op: replace(默认) | append | prepend
 * pos: "行号#哈希"（Hashline 格式）
 * end: "行号#哈希"（范围替换，仅 replace）
 *
 * 向后兼容旧格式：
 *   - lineHash（仅哈希，无行号）→ 自动补为 "0#hash" 走旧逻辑
 *   - oldText/newText → 走模糊匹配
 *   - 顶层 filePath + oldString/newString → 旧 API
 */
function normalizeEditArguments(input: Record<string, any>): FileEditGroup[] {
  const args = input as LegacyEditArgs;

  const allEdits: any[] = Array.isArray(args.edits)
    ? [...args.edits]
    : [];

  // 检测纯旧格式：顶层 oldString / newString（没有 edits 数组时）
  if (allEdits.length === 0 && (typeof args.oldString === 'string' || typeof args.newString === 'string')) {
    if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
      throw new Error('使用旧格式时 oldString 和 newString 必须同时提供且均为字符串。');
    }
    const fp = args.filePath;
    if (!fp || typeof fp !== 'string') {
      throw new Error('必须提供 filePath（旧格式请放在顶层）。');
    }
    allEdits.push({ filePath: fp, oldText: args.oldString, newText: args.newString });
  }

  if (allEdits.length === 0) {
    throw new Error('至少需要提供一个编辑操作（edits[] 或 oldString/newString）。');
  }

  // 按 filePath 分组
  const groups = new Map<string, {
    hashEdits: HashEdit[];
    oldTextEdits: ReplaceEdit[];
    appendEdits: AppendEdit[];
    prependEdits: PrependEdit[];
    rangeEdits: RangeEdit[];
  }>();

  for (const e of allEdits) {
    const fp = (typeof e.filePath === 'string' && e.filePath.length > 0)
      ? e.filePath
      : (typeof args.filePath === 'string' ? args.filePath : null);
    if (!fp) {
      throw new Error('每个编辑条目必须提供 filePath。');
    }

    let group = groups.get(fp);
    if (!group) {
      group = { hashEdits: [], oldTextEdits: [], appendEdits: [], prependEdits: [], rangeEdits: [] };
      groups.set(fp, group);
    }

    const newText: string = e.newText ?? '';
    const posStr = (e.pos != null ? String(e.pos) : '').trim();
    const endStr = (e.end != null ? String(e.end) : '').trim();
    const op = (typeof e.op === 'string' ? e.op.toLowerCase() : '') || 'replace';

    // ── 解析 pos（兼容旧 lineHash） ──
    let parsedPos: { lineNum: number; hash: string } | null = null;
    if (posStr) {
      // Hashline 格式："行号#哈希"
      const m = posStr.match(/^(\d+)#([0-9a-f]+)$/i);
      if (m) {
        parsedPos = { lineNum: parseInt(m[1], 10), hash: m[2].toLowerCase() };
      } else if (/^[0-9a-f]+$/i.test(posStr)) {
        // 兼容旧 lineHash（仅哈希，无行号）→ 转为 HashEdit
        group.hashEdits.push({ lineHash: posStr.toLowerCase(), newText });
        continue;
      } else {
        throw new Error(`无效的 pos 格式 "${posStr}"，应为 "行号#哈希"（如 "11#a1b2"）。请使用 read(lineHash=true) 重新读取。`);
      }
    }

    // ── 解析 end（仅 replace） ──
    let parsedEnd: { lineNum: number; hash: string } | null = null;
    if (endStr) {
      const m = endStr.match(/^(\d+)#([0-9a-f]+)$/i);
      if (m) {
        parsedEnd = { lineNum: parseInt(m[1], 10), hash: m[2].toLowerCase() };
      } else {
        throw new Error(`无效的 end 格式 "${endStr}"，应为 "行号#哈希"（如 "25#c3d4"）。`);
      }
    }

    // ── 根据 op 分发 ──
    if (op === 'append') {
      group.appendEdits.push({ pos: parsedPos, newText });
    } else if (op === 'prepend') {
      group.prependEdits.push({ pos: parsedPos, newText });
    } else if (parsedEnd) {
      // replace with range
      group.rangeEdits.push({ pos: parsedPos!, end: parsedEnd, newText });
    } else if (parsedPos) {
      // replace single line via Hashline
      group.hashEdits.push({ lineHash: parsedPos.hash, lineNum: parsedPos.lineNum, newText });
    } else {
      // No pos given → must have oldText
      const hasOldText = typeof e.oldText === 'string' && e.oldText.length > 0;
      if (hasOldText) {
        group.oldTextEdits.push({ oldText: e.oldText!, newText });
      } else {
        throw new Error('每个编辑条目必须提供 pos、lineHash 或 oldText 中的一个。');
      }
    }
  }

  return Array.from(groups.entries()).map(([filePath, g]) => ({
    filePath,
    edits: g.oldTextEdits,
    hashEdits: g.hashEdits,
    appendEdits: g.appendEdits,
    prependEdits: g.prependEdits,
    rangeEdits: g.rangeEdits,
  }));
}

// ============================================================
// 主执行流水线
// ============================================================

/**
 * edit 工具的完整执行流水线：
 *   1. resolveToCwd     —— 路径解析
 *   2. readFile         —— 读取原始内容
 *   3. stripBom         —— 去除 BOM
 *   4. detectLineEnding —— 检测行尾风格
 *   5. normalizeToLF    —— 统一为 LF
 *   6. applyEditsToNormalizedContent —— 执行精确替换
 *   7. generateDiffString —— 生成 diff 输出
 *   8. restoreLineEndings —— 恢复原始行尾
 *   9. writeFile        —— 写回文件
 */
async function executeEditPipeline(
  filePath: string,
  edits: ReplaceEdit[],
  hashEdits: HashEdit[],
  appendEdits: AppendEdit[],
  prependEdits: PrependEdit[],
  rangeEdits: RangeEdit[],
  ops: EditOperations = defaultEditOperations,
): Promise<{
  diff: string;
  firstChangedLine: number | undefined;
  fuzzyMatches: number; updatedHashInfo: HashUpdateInfo[];
}> {
  const safePath = resolveSafePath(filePath);

  return withFileMutationQueue(safePath, async () => {
    // 1. 检查文件存在且可读写
    await ops.access(safePath);

    // 2. 读取原始内容
    const buffer = await ops.readFile(safePath);
    let content = buffer.toString('utf-8');

    // 3. 剥离 BOM
    content = stripBom(content);

    // 4. 检测行尾风格
    const lineEnding = detectLineEnding(content);

    // 5. 归一化为 LF
    let normalized = normalizeToLF(content);

    // 6. 对 hash/newText 归一化
    const normalizedHashEdits = hashEdits.map((e) => ({
      lineHash: e.lineHash,
      lineNum: e.lineNum,
      newText: normalizeToLF(e.newText),
    }));
    const normalizedAppendEdits = appendEdits.map((e) => ({
      pos: e.pos,
      newText: normalizeToLF(e.newText),
    }));
    const normalizedPrependEdits = prependEdits.map((e) => ({
      pos: e.pos,
      newText: normalizeToLF(e.newText),
    }));
    const normalizedRangeEdits = rangeEdits.map((e) => ({
      pos: e.pos,
      end: e.end,
      newText: normalizeToLF(e.newText),
    }));

    const normalizedEdits = edits.map((e) => ({
      oldText: normalizeToLF(e.oldText),
      newText: normalizeToLF(e.newText),
    }));

    // 执行顺序：prepend → hashEdits → rangeEdits → append → oldText
    // （prepend/append 可能改变行号，但 hash 编辑依赖行号验证，所以 hash 编辑在 prepend 之后）
    // 实际上 append/prepend/range 和 hash 编辑在不同的行上，互不影响。
    // 但 oldText（模糊匹配）始终最后执行。

    const baseContent = normalized;
    let currentContent = normalized;
    let allEditPositions: EditPosition[] = [];
    let allUpdatedHashInfo: HashUpdateInfo[] = [];

    // prepend（文件开头插入）
    for (const pe of normalizedPrependEdits) {
      const { newContent, editPositions, updatedHashInfo } = applyPrependEdits(currentContent, pe, filePath);
      currentContent = newContent;
      allEditPositions.push(...editPositions);
      allUpdatedHashInfo.push(...updatedHashInfo);
    }

    // hash 编辑（单行替换，行号+哈希双重验证）
    if (normalizedHashEdits.length > 0) {
      const { newContent, editPositions, updatedHashInfo } = applyHashBasedEdits(currentContent, normalizedHashEdits, filePath);
      currentContent = newContent;
      allEditPositions.push(...editPositions);
      allUpdatedHashInfo.push(...updatedHashInfo);
    }

    // range 编辑（范围替换）
    for (const re of normalizedRangeEdits) {
      const { newContent, editPositions, updatedHashInfo } = applyRangeEdits(currentContent, re, filePath);
      currentContent = newContent;
      allEditPositions.push(...editPositions);
      allUpdatedHashInfo.push(...updatedHashInfo);
    }

    // append（文件末尾 / 指定行后插入）
    for (const ae of normalizedAppendEdits) {
      const { newContent, editPositions, updatedHashInfo } = applyAppendEdits(currentContent, ae, filePath);
      currentContent = newContent;
      allEditPositions.push(...editPositions);
      allUpdatedHashInfo.push(...updatedHashInfo);
    }

    // oldText 编辑（模糊匹配，最后执行）
    if (normalizedEdits.length > 0) {
      const { baseContent: bc2, newContent: nc2, editPositions: ep2 } = applyEditsToNormalizedContent(
        currentContent,
        normalizedEdits,
        filePath,
      );
      currentContent = nc2;
      allEditPositions.push(...ep2);
    }

    const newContent = currentContent;

    // 9. 生成 diff
    const hasStructuralEdits = normalizedHashEdits.length > 0 || normalizedAppendEdits.length > 0
      || normalizedPrependEdits.length > 0 || normalizedRangeEdits.length > 0;
    const isMixed = hasStructuralEdits && normalizedEdits.length > 0;
    const { diff, firstChangedLine } = isMixed || allEditPositions.length === 0
      ? generateDiffString(baseContent, newContent)
      : generateIncrementalDiff(baseContent, newContent, allEditPositions);

    // 10. 恢复原始行尾
    const finalContent = restoreLineEndings(newContent, lineEnding);

    // 11. 写回文件
    await ops.writeFile(safePath, finalContent);

    // 统计模糊匹配次数（仅 oldText 编辑）
    let fuzzyMatches = 0;
    for (const edit of normalizedEdits) {
      if (!baseContent.includes(edit.oldText)) {
        fuzzyMatches++;
      }
    }

    return { diff, firstChangedLine, fuzzyMatches, updatedHashInfo: allUpdatedHashInfo };
  });
}

// ============================================================
// Hashline DSL 执行器
// ============================================================

/**
 * 执行 Hashline DSL patch。
 * 流程：解析 DSL → 验证 TAG → 应用操作 → 更新快照 → 返回 diff。
 */
async function executeHashlineDSL(input: string, stream: any): Promise<string> {
  const cwd = process.cwd();
  const sections = parseHashlinePatch(input, cwd);

  if (sections.length === 0) {
    throw new Error('未找到有效的 Hashline section。请以 [PATH#TAG] 开头。');
  }

  const results: any[] = [];

  for (const section of sections) {
    const safePath = resolveSafePath(section.path);
    stream?.onChunk?.(`正在编辑: ${section.path} (${section.ops.length} 处操作)...\n`);

    await withFileMutationQueue(safePath, async () => {
      // 读取当前文件内容
      let content: string;
      try {
        content = await fs.readFile(safePath, 'utf-8');
      } catch {
        throw new Error(`文件不存在: ${section.path}。如需创建新文件请使用 write 工具。`);
      }

      // BOM 剥离 + 行尾归一化
      content = stripBom(content);
      const lineEnding = detectLineEnding(content);
      content = normalizeToLF(content);

      // 验证 TAG（文件版本检查）
      if (section.tag) {
        if (!verifySnapshot(safePath, section.tag, content)) {
          const currentTag = computeFileHash(content);
          throw new Error(
            `Hashline TAG 不匹配：patch 中为 "#${section.tag}"，但当前文件哈希为 "#${currentTag}"。` +
            `文件可能已被修改，请重新 read 获取最新 TAG。`
          );
        }
      }

      // 应用操作
      const lines = content.split('\n');
      let newContent = content;

      for (const op of section.ops) {
        switch (op.kind) {
          case 'swap': {
            const startIdx = op.startLine - 1;
            const endIdx = op.endLine - 1;
            if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
              throw new Error(`SWAP ${op.startLine}.=${op.endLine}: 行号超出范围（文件共 ${lines.length} 行）。`);
            }
            const currentLines = newContent.split('\n');
            const before = currentLines.slice(0, startIdx);
            const after = currentLines.slice(endIdx + 1);
            newContent = [...before, ...op.lines, ...after].join('\n');
            break;
          }
          case 'ins_pre': {
            const idx = op.anchorLine - 1;
            if (idx < 0 || idx > lines.length) {
              throw new Error(`INS.PRE ${op.anchorLine}: 行号超出范围（文件共 ${lines.length} 行）。`);
            }
            const currentLines = newContent.split('\n');
            const before = currentLines.slice(0, idx);
            const after = currentLines.slice(idx);
            newContent = [...before, ...op.lines, ...after].join('\n');
            break;
          }
          case 'ins_post': {
            const idx = op.anchorLine; // 在该行之后
            if (idx < 0 || idx > lines.length) {
              throw new Error(`INS.POST ${op.anchorLine}: 行号超出范围（文件共 ${lines.length} 行）。`);
            }
            const currentLines = newContent.split('\n');
            const before = currentLines.slice(0, idx);
            const after = currentLines.slice(idx);
            newContent = [...before, ...op.lines, ...after].join('\n');
            break;
          }
          case 'ins_head': {
            newContent = [...op.lines, ...newContent.split('\n')].join('\n');
            break;
          }
          case 'ins_tail': {
            const currentLines = newContent.split('\n');
            newContent = [...currentLines, ...op.lines].join('\n');
            break;
          }
          default:
            stream?.onChunk?.(`[跳过] 不支持的操作: ${(op as any).kind}\n`);
        }
      }

      // 恢复行尾 + 写回
      const finalContent = restoreLineEndings(newContent, lineEnding);
      await fs.writeFile(safePath, finalContent, 'utf-8');

      // 更新快照
      updateSnapshot(safePath, newContent);

      // 生成 diff
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

// ============================================================
// 工具定义
// ============================================================

export const tool: Tool = {
  ...meta,

  extractLabel: (args) => {
    const editItems = Array.isArray(args.edits) ? args.edits : [];
    const filePath = editItems[0]?.filePath || args.filePath || '';
    const edits = editItems;
    const count = edits.length > 0
      ? edits.length
      : (args.oldString ? 1 : 0);
    const summary = count > 0 ? `${count} 处替换` : '编辑';
    return filePath ? `${filePath} (${summary})` : summary;
  },

  definition: {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Hashline v2 编辑协议。推荐使用 input（DSL patch 字符串）：[PATH#TAG] 头 + SWAP/INS 操作。也兼容 edits（JSON 数组）旧格式。',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Hashline DSL patch 字符串（推荐）。格式：每节以 [PATH#TAG] 开头，后跟操作。支持 SWAP/INS.PRE/INS.POST/INS.HEAD/INS.TAIL。如 "[src/a.ts#a1b2]\\nSWAP 2.=3:\\n+新行2\\n+新行3"。TAG 来自 read 输出的 [PATH#TAG] 头部。',
          },
          edits: {
            type: 'array',
            description: 'JSON 编辑列表（兼容旧格式）。每项含 filePath + op + pos + newText。',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: '文件路径。' },
                op: { type: 'string', enum: ['replace', 'append', 'prepend'], description: '操作类型。默认 replace。' },
                pos: { type: 'string', description: '"行号#哈希" 定位。' },
                end: { type: 'string', description: '范围结束位置（仅 replace）。' },
                newText: { type: 'string', description: '新文本 / 插入内容。' },
              },
              required: ['filePath', 'newText'],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
      },
    },
  },

  async execute(args: Record<string, any>, stream): Promise<string> {
    try {
      // ── Hashline DSL 模式（推荐） ──
      if (typeof args.input === 'string' && args.input.trim().length > 0) {
        return await executeHashlineDSL(args.input, stream);
      }

      // ── JSON edits 模式（向后兼容） ──
      // 0. 参数归一化（按 filePath 自动分组）
      const groups = normalizeEditArguments(args);

      const results: any[] = [];
      for (const group of groups) {
        const { filePath, edits, hashEdits, appendEdits, prependEdits, rangeEdits } = group;
        const totalEdits = edits.length + hashEdits.length + appendEdits.length + prependEdits.length + rangeEdits.length;
        stream?.onChunk?.(
          `正在编辑: ${filePath} (${totalEdits} 处操作` +
          `${hashEdits.length > 0 ? `，${hashEdits.length} 处哈希定位` : ''}` +
          `${appendEdits.length > 0 ? `，${appendEdits.length} 处追加` : ''}` +
          `${prependEdits.length > 0 ? `，${prependEdits.length} 处前置` : ''}` +
          `${rangeEdits.length > 0 ? `，${rangeEdits.length} 处范围替换` : ''})...\n`
        );

        // 1-10. 执行完整流水线
        const { diff, firstChangedLine, fuzzyMatches, updatedHashInfo } = await executeEditPipeline(
          filePath, edits, hashEdits, appendEdits, prependEdits, rangeEdits,
        );

        const appliedCount = diff === '（无变更）' ? 0 : totalEdits;
        stream?.onChunk?.(
          `编辑完成，${appliedCount} 处替换` +
          (fuzzyMatches > 0 ? `（含 ${fuzzyMatches} 处模糊匹配）` : '') + `\n`
        );

        results.push({
          path: filePath,
          file: path.basename(filePath),
          edits_applied: appliedCount,
          fuzzy_matches: fuzzyMatches,
          updated_hashes: updatedHashInfo.map(h => ({ old_hash: h.oldHash, new_hashes: h.newHashes })),
          first_changed_line: firstChangedLine,
          diff,
        });
      }

      return JSON.stringify({
        status: 'success',
        data: groups.length === 1
          ? results[0]                          // 单文件：扁平输出
          : { files: results },                 // 多文件：files 数组
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: {
          path: args.edits?.[0]?.filePath || args.filePath || '',
          message: err.message,
        },
      });
    }
  },
};
