// ============================================================
// edit 工具 —— 精确字符串替换编辑
// 路径防御：强制限制在工作区目录内
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';

function safeResolve(filePath: string): string {
  const sandbox = path.resolve(getGlobalConfig().workspaceDir);
  const resolved = path.resolve(sandbox, filePath);

  if (!resolved.startsWith(sandbox + path.sep) && resolved !== sandbox) {
    throw new Error(
      `路径穿越被拒绝："${filePath}" 解析到了工作区 "${sandbox}" 之外`
    );
  }
  return resolved;
}

export const tool: Tool = {
  displayName: '编辑',
  description: '编辑工作区中的文件',
  extractLabel: (args) => args.filePath || '',
  definition: {
    type: 'function',
    function: {
      name: 'edit',
      description: '编辑工作区中的文件',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '要编辑的文件路径。',
          },
          oldString: {
            type: 'string',
            description: '要被替换的精确文本。',
          },
          newString: {
            type: 'string',
            description: '替换后的新文本。',
          },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    try {
      const safePath = safeResolve(args.filePath);
      const content = await fs.readFile(safePath, 'utf-8');

      const oldStr: string = args.oldString;
      const newStr: string = args.newString;

      if (!content.includes(oldStr)) {
        return JSON.stringify({
          status: 'error',
          data: {
            path: safePath,
            message: '在文件中未找到 oldString，未进行任何更改。',
          },
        });
      }

      // 只替换第一次出现
      const newContent = content.replace(oldStr, newStr);
      await fs.writeFile(safePath, newContent, 'utf-8');

      const occurrences = content.split(oldStr).length - 1;
      return JSON.stringify({
        status: 'success',
        data: {
          path: safePath,
          replacements: occurrences,
          old_string: oldStr.slice(0, 200),
          new_string: newStr.slice(0, 200),
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
