// ============================================================
// edit 工具 —— Hashline 内容哈希编辑协议 v2
//
// 支持两种输入模式（共用 executor.ts 统一管线 applyEditBatch）：
//
// 1. Hashline DSL（推荐，token 效率最高）：
//    { input: "[path#a1b2]\nSWAP 2.=3:\n+新行2\n+新行3" }
//    参考 oh-my-pi 的 patch 语言
//
// 2. JSON edits（兼容旧格式）：
//    { edits: [{ filePath, op, pos, newText }] }
//
// 本文件职责（2026-08-12 重构后）：
//   · 参数归一化：两条路径的输入统一为 LineEdit[]（行级）+ ReplaceEdit[]（文本）
//   · 工具定义：DSL 走 hashline-executor（parser → 统一管线），JSON 直接走统一管线
//   读/写/验证/快照/diff 等全部收敛于 executor.ts，消除两条路径重复。
// ============================================================

import * as path from 'path';
import type { AgentConfig } from '@agents/config';
import { defineTool } from '../../../define-tool';
import { normalizeToLF } from './line-ending';
import { applyEditBatch, defaultEditOperations } from './executor';
import { executeHashlineDSL } from './hashline-executor';
import type { LineEdit, ReplaceEdit, HashPos } from './types';

// ============================================================
// Legacy API 兼容：oldString/newString → edits[]
// ============================================================

interface LegacyEditArgs {
  filePath?: string;
  oldString?: string;
  newString?: string;
  /** 下划线风格别名（新工具描述采用 old_string/new_string，与 read/write 参数风格一致） */
  old_string?: string;
  new_string?: string;
  edits?: ReplaceEdit[];
  [key: string]: unknown;
}

// ── 归一化结果：按文件分组为统一行级编辑 + 文本编辑 ──
interface FileEditBatch {
  filePath: string;
  lineEdits: LineEdit[];
  textEdits: ReplaceEdit[];
}

/** 解析 pos/end 字符串：Hashline "行号#哈希" / 裸行号 / 纯哈希（旧 lineHash） */
function parseHashPos(posStr: string): { pos: HashPos | null; hashOnly?: string } {
  const m = posStr.match(/^(\d+)#([0-9a-f]+)$/i);
  if (m) {
    return { pos: { lineNum: parseInt(m[1], 10), hash: m[2].toLowerCase() } };
  }
  if (/^\d+$/.test(posStr)) {
    // 裸行号（read v2 输出格式，无每行哈希）→ hash 留空，执行时从 read 快照解析。
    // 必须在纯哈希分支之前判定：纯数字（如 "20"）也满足 [0-9a-f]+，应优先视为行号。
    return { pos: { lineNum: parseInt(posStr, 10), hash: '', snapshotLine: true } };
  }
  if (/^[0-9a-f]*[a-f][0-9a-f]*$/i.test(posStr)) {
    // 兼容旧 lineHash（仅哈希，无行号，须含字母 a-f 以与裸行号区分）
    return { pos: null, hashOnly: posStr.toLowerCase() };
  }
  throw new Error(`无效的 pos 格式 "${posStr}"，应为 "行号#哈希"（如 "11#a1b2"）或裸行号（如 "20"）。请先 read 获取行号与 [PATH#TAG]。`);
}

/**
 * 参数归一化（新架构：统一行级编辑模型）。
 * 兼容 4 种输入形态：
 *   - edits[] 数组：op=replace/append/prepend + pos/end（"行号#哈希"/裸行号/纯哈希）+ newText
 *   - edits[] 数组：oldText/newText → 文本匹配
 *   - 顶层 oldString/newString（旧 API）
 *   - 顶层 old_string/new_string（下划线风格别名）
 */
function normalizeEditArguments(input: Record<string, any>): FileEditBatch[] {
  const args = input as LegacyEditArgs;

  const allEdits: any[] = Array.isArray(args.edits)
    ? [...args.edits]
    : [];

  // 纯旧格式：顶层 oldString / newString（没有 edits 数组时）
  if (allEdits.length === 0 && (typeof args.oldString === 'string' || typeof args.newString === 'string'
    || typeof args.old_string === 'string' || typeof args.new_string === 'string')) {
    const oldText = args.old_string ?? args.oldString;
    const newText = args.new_string ?? args.newString;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw new Error('使用旧格式时 oldString 和 newString 必须同时提供且均为字符串。');
    }
    const fp = args.filePath ?? args.path;
    if (!fp || typeof fp !== 'string') {
      throw new Error('必须提供 filePath（旧格式请放在顶层）。');
    }
    allEdits.push({ filePath: fp, oldText, newText });
  }

  if (allEdits.length === 0) {
    throw new Error('至少需要提供一个编辑操作（edits[] 或 oldString/newString）。');
  }

  const groups = new Map<string, { lineEdits: LineEdit[]; textEdits: ReplaceEdit[] }>();

  for (const e of allEdits) {
    const fp = (typeof e.filePath === 'string' && e.filePath.length > 0)
      ? e.filePath
      : (typeof e.path === 'string' && e.path.length > 0)
        ? e.path
        : (typeof args.filePath === 'string' ? args.filePath : (typeof args.path === 'string' ? args.path : null));
    if (!fp) {
      throw new Error('每个编辑条目必须提供 filePath。');
    }

    let group = groups.get(fp);
    if (!group) {
      group = { lineEdits: [], textEdits: [] };
      groups.set(fp, group);
    }

    const newText: string = e.newText ?? '';
    const lines = (): string[] => normalizeToLF(newText).split('\n');
    const posStr = (e.pos != null ? String(e.pos) : '').trim();
    const endStr = (e.end != null ? String(e.end) : '').trim();
    const op = (typeof e.op === 'string' ? e.op.toLowerCase() : '') || 'replace';

    // ── 解析 pos / end ──
    const parsedPos = posStr ? parseHashPos(posStr) : { pos: null };
    const parsedEnd = endStr ? parseHashPos(endStr) : { pos: null };

    // ── 根据 op 分发到统一行级编辑模型 ──
    if (op === 'append') {
      if (parsedPos.pos) {
        const p = parsedPos.pos;
        group.lineEdits.push({
          kind: 'insert-after', anchorLine: p.lineNum, lines: lines(),
          hashes: { anchor: p.snapshotLine ? '' : p.hash },
        });
      } else {
        group.lineEdits.push({ kind: 'insert-end', lines: lines() });
      }
    } else if (op === 'prepend') {
      if (parsedPos.pos) {
        const p = parsedPos.pos;
        group.lineEdits.push({
          kind: 'insert-before', anchorLine: p.lineNum, lines: lines(),
          hashes: { anchor: p.snapshotLine ? '' : p.hash },
        });
      } else {
        group.lineEdits.push({ kind: 'insert-start', lines: lines() });
      }
    } else if (parsedEnd.pos) {
      // replace with range（两端定位）
      const p = parsedPos.pos, ep = parsedEnd.pos;
      if (!p) {
        throw new Error('范围替换需要 pos 与 end 均为 "行号#哈希" 或裸行号。');
      }
      group.lineEdits.push({
        kind: 'replace', startLine: p.lineNum, endLine: ep.lineNum, lines: lines(),
        hashes: {
          start: p.snapshotLine ? '' : p.hash,
          end: ep.snapshotLine ? '' : ep.hash,
        },
      });
    } else if (parsedPos.pos) {
      // replace single line via Hashline（裸行号 → snapshotLine 待解析）
      const p = parsedPos.pos;
      group.lineEdits.push({
        kind: 'replace', startLine: p.lineNum, endLine: p.lineNum, lines: lines(),
        hashes: { start: p.snapshotLine ? '' : p.hash },
      });
    } else if (parsedPos.hashOnly) {
      // 纯哈希定位（兼容旧 lineHash，无行号）→ 管线从文件内容解析行号
      group.lineEdits.push({ kind: 'replace', lines: lines(), lineHashOnly: parsedPos.hashOnly });
    } else {
      // 无 pos → oldText 文本匹配
      const hasOldText = typeof e.oldText === 'string' && e.oldText.length > 0;
      if (hasOldText) {
        group.textEdits.push({ oldText: e.oldText!, newText });
      } else {
        throw new Error('每个编辑条目必须提供 pos、lineHash 或 oldText 中的一个。');
      }
    }
  }

  return Array.from(groups.entries()).map(([filePath, g]) => ({
    filePath,
    lineEdits: g.lineEdits,
    textEdits: g.textEdits,
  }));
}

// ============================================================
// 工具定义（新架构：defineTool 工厂，per-Agent 烘焙沙箱）
// ============================================================

export function makeEditTool(config: AgentConfig) {
  return defineTool({
    name: 'edit',
    label: '编辑文件',
    ns: 'tool.edit',
    requires: ['agent'],
    description: 'Hashline v2 编辑协议。行级编辑用 input（DSL patch 字符串）：[PATH#TAG] 头 + SWAP/INS 操作（推荐，直接配 read 的 [PATH#TAG] 与行号）。也支持 edits（JSON 数组）：pos/end 用 "行号#哈希" 或裸行号（如 "20"，基于 read 快照校验，无需每行哈希）。',
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
              pos: { type: 'string', description: '"行号#哈希" 或裸行号（如 "20"，基于 read 快照校验）。' },
              end: { type: 'string', description: '范围结束位置（仅 replace），格式同 pos。' },
              newText: { type: 'string', description: '新文本 / 插入内容。' },
            },
            required: ['filePath', 'newText'],
            additionalProperties: false,
          },
          minItems: 1,
        },
      },
    },
    extractLabel: (args) => {
      const editItems = Array.isArray(args.edits) ? args.edits : [];
      const filePath = editItems[0]?.filePath || args.filePath || '';
      const count = editItems.length > 0
        ? editItems.length
        : (args.oldString ? 1 : 0);
      const summary = count > 0 ? `${count} 处替换` : '编辑';
      return filePath ? `${filePath} (${summary})` : summary;
    },
    execute: async (args: Record<string, any>, stream) => {
      try {
        // ── Hashline DSL 模式（推荐） ──
        if (typeof args.input === 'string' && args.input.trim().length > 0) {
          return await executeHashlineDSL(config, args.input, stream);
        }

        // ── JSON edits 模式（向后兼容） ──
        const groups = normalizeEditArguments(args);
        const results: any[] = [];

        for (const group of groups) {
          const totalEdits = group.lineEdits.length + group.textEdits.length;
          stream?.onChunk?.(
            `正在编辑: ${group.filePath} (${totalEdits} 处操作` +
            `${group.lineEdits.length > 0 ? `，${group.lineEdits.length} 处行级定位` : ''}` +
            `${group.textEdits.length > 0 ? `，${group.textEdits.length} 处文本匹配` : ''})...\n`
          );

          const { diff, firstChangedLine, fuzzyMatches, updatedHashInfo, fileTag } = await applyEditBatch(
            config,
            group.filePath,
            { lineEdits: group.lineEdits, textEdits: group.textEdits },
            defaultEditOperations,
          );

          const appliedCount = diff === '（无变更）' ? 0 : totalEdits;
          stream?.onChunk?.(
            `编辑完成，${appliedCount} 处替换` +
            (fuzzyMatches > 0 ? `（含 ${fuzzyMatches} 处模糊匹配）` : '') + `\n`
          );

          results.push({
            path: group.filePath,
            file: path.basename(group.filePath),
            edits_applied: appliedCount,
            fuzzy_matches: fuzzyMatches,
            updated_hashes: updatedHashInfo.map(h => ({ old_hash: h.oldHash, new_hashes: h.newHashes })),
            file_tag: fileTag,
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
  });
}
