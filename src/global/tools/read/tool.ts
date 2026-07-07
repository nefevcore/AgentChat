// ============================================================
// read 工具 —— 读取文件内容 / 列出目录
// 路径防御：强制限制在工作区目录内
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';

/** 安全解析路径，防御路径穿越攻击 */
function safeResolve(filePath: string): string {
  const sandbox = path.resolve(getGlobalConfig().workspaceDir);
  const resolved = path.resolve(sandbox, filePath);

  // 确保解析后的路径在工作区内
  if (!resolved.startsWith(sandbox + path.sep) && resolved !== sandbox) {
    throw new Error(
      `路径穿越被拒绝："${filePath}" 解析到了工作区 "${sandbox}" 之外`
    );
  }
  return resolved;
}

export const tool: Tool = {
  displayName: '读取',
  description: '读取工作区中的文件或文件目录',
  extractLabel: (args) => args.filePath || '',
  definition: {
    type: 'function',
    function: {
      name: 'read',
      description: '读取工作区中的文件或文件目录',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '要读取的文件路径，或要列出内容的目录路径。',
          },
          startLine: {
            type: 'number',
            description: '起始行号（1-based，含）。仅读取文件时生效。',
          },
          endLine: {
            type: 'number',
            description: '结束行号（1-based，含）。仅读取文件时生效。',
          },
        },
        required: ['filePath'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    try {
      const safePath = safeResolve(args.filePath);
      const stat = await fs.stat(safePath);

      // 目录：返回文件清单
      if (stat.isDirectory()) {
        const entries = await fs.readdir(safePath, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }));
        // 目录在前，文件在后，各自按名称排序
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return JSON.stringify({
          status: 'success',
          data: {
            path: safePath,
            type: 'directory',
            items,
            count: items.length,
          },
        });
      }

      // 文件：读取内容
      const content = await fs.readFile(safePath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      // 行数范围处理
      const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
      const endLine = typeof args.endLine === 'number' ? args.endLine : totalLines;

      // 边界修正
      const start = Math.max(1, startLine);
      const end = Math.min(totalLines, endLine);

      if (start > totalLines) {
        return JSON.stringify({
          status: 'error',
          data: {
            path: safePath,
            message: `startLine ${startLine} 超出文件总行数 ${totalLines}`,
          },
        });
      }

      // 提取指定范围的行
      const selectedLines = lines.slice(start - 1, end);
      const selectedContent = selectedLines.join('\n');
      const isRange = start > 1 || end < totalLines;

      // 截断过长内容
      const maxLen = getGlobalConfig().readOutputMaxLen;
      const truncated = selectedContent.length > maxLen;
      const displayContent = truncated ? selectedContent.slice(0, maxLen) : selectedContent;

      return JSON.stringify({
        status: 'success',
        data: {
          path: safePath,
          content: displayContent,
          size: stat.size,
          truncated,
          total_bytes: content.length,
          total_lines: totalLines,
          ...(isRange ? { start_line: start, end_line: end } : {}),
        },
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: {
          path: args.filePath,
          message: err.message,
        },
      });
    }
  },
};
