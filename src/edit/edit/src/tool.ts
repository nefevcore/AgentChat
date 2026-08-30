// ============================================================
// edit 工具 —— 文本匹配编辑（old_string/new_string）
//
// 2026-08-20 简化（基于 5035 次真实调用统计）：
//   · 收敛为顶层 file_path + old_string/new_string 单一形态
//   · 移除 Hashline DSL（input）、行级定位（op/pos/end）、edits[] 批量
//     —— 多处修改由 Agent 在一次回复中并行发多个 edit 调用承担
//     （LLM 原生并行 tool_call，与 edits[] 无区别）
//   · 移除 [PATH#TAG] / 快照 / 行哈希校验链路（无消费方）
//   · 保留：三级模糊匹配、唯一性校验、重叠检测、增量 diff、
//     行尾保留、文件突变队列（同文件并发串行化）
// ============================================================

import * as path from 'path';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import { defineTool } from '@agentchat/toolkit';
import { applyEditBatch, defaultEditOperations } from './executor';
import type { ReplaceEdit } from './types';

/** 兼容旧 camelCase 入参的兜底读取（schema 只声明 snake_case 正典） */
function readArgs(args: Record<string, any>): { filePath: string; oldText: string; newText: string } {
  const filePath = args.file_path ?? args.filePath ?? args.path;
  const oldText = args.old_string ?? args.oldString ?? args.old_text ?? args.oldText;
  const newText = args.new_string ?? args.newString ?? args.new_text ?? args.newText;

  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('缺少 file_path 参数（目标文件路径，相对工作区）。');
  }
  if (typeof oldText !== 'string' || oldText.length === 0) {
    throw new Error('缺少 old_string 参数（要替换的原文，可从 read 输出复制）。');
  }
  if (typeof newText !== 'string') {
    throw new Error('缺少 new_string 参数（替换后的新文本；传空字符串表示删除 old_string）。');
  }
  return { filePath, oldText, newText };
}

// ============================================================
// 工具定义（defineTool 工厂，per-Agent 烘焙沙箱）
// ============================================================

export function makeEditTool(config: AgentConfig) {
  return defineTool({
    name: 'edit',
    label: '编辑文件',
    requires: [CAPABILITY_BASE],
    description: '通过替换文本内容来编辑文本文件。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要替换的原文' },
        new_string: { type: 'string', description: '替换后的文本' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    extractLabel: (args) => {
      const fp = args.file_path || args.filePath || '';
      const hasOld = !!(args.old_string || args.oldString || args.old_text || args.oldText);
      return fp ? `${fp}${hasOld ? ' (替换)' : ''}` : '编辑';
    },
    execute: async (args: Record<string, any>, stream) => {
      let filePath = '';
      try {
        // 已移除的旧形态：给出明确迁移引导（而非神秘报错）
        if (typeof args.input === 'string' && args.input.trim().length > 0) {
          return JSON.stringify({
            status: 'error',
            data: {
              message: 'Hashline DSL（input 参数）已移除。请改用 old_string/new_string 文本匹配：先 read 复制原文，再 edit(file_path, old_string, new_string)。',
            },
          });
        }
        if (Array.isArray(args.edits) && args.edits.length > 0) {
          return JSON.stringify({
            status: 'error',
            data: {
              message: 'edits[] 批量编辑已移除。多处修改请并行发多个 edit 调用（每次 edit(file_path, old_string, new_string) 改一处）。',
            },
          });
        }
        if (args.pos != null || args.op != null || args.end != null) {
          return JSON.stringify({
            status: 'error',
            data: {
              message: '行级定位（op/pos/end）已移除。请改用 old_string/new_string 文本匹配。',
            },
          });
        }

        const { filePath: fp, oldText, newText } = readArgs(args);
        filePath = fp;
        const edits: ReplaceEdit[] = [{ oldText, newText }];

        stream?.onChunk?.(`正在编辑: ${filePath}（1 处文本匹配）...\n`);

        const { diff, firstChangedLine, fuzzyMatches } = await applyEditBatch(
          config,
          filePath,
          { textEdits: edits },
          defaultEditOperations,
        );

        const appliedCount = diff === '（无变更）' ? 0 : 1;
        stream?.onChunk?.(
          `编辑完成，${appliedCount} 处替换` +
          (fuzzyMatches > 0 ? `（含 ${fuzzyMatches} 处模糊匹配）` : '') + `\n`
        );

        return JSON.stringify({
          status: 'success',
          data: {
            path: filePath,
            file: path.basename(filePath),
            edits_applied: appliedCount,
            fuzzy_matches: fuzzyMatches,
            first_changed_line: firstChangedLine,
            diff,
          },
        });
      } catch (err: any) {
        return JSON.stringify({
          status: 'error',
          data: {
            path: filePath,
            message: err.message,
          },
        });
      }
    },
  });
}
