// ============================================================
// write 工具 —— 写入文件 / 创建目录
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
  displayName: '写入',
  description: '在工作区中创建或覆盖写入文件',
  extractLabel: (args) => args.filePath || '',
  definition: {
    type: 'function',
    function: {
      name: 'write',
      description: '在工作区中创建或覆盖写入文件',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '要写入的文件路径。以 / 结尾表示创建目录。',
          },
          content: {
            type: 'string',
            description: '要写入文件的内容（创建目录时无需提供）。',
          },
        },
        required: ['filePath'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    try {
      const safePath = safeResolve(args.filePath);

      // 以 / 结尾表示创建目录
      if (args.filePath.endsWith('/') || args.filePath.endsWith('\\')) {
        await fs.mkdir(safePath, { recursive: true });
        return JSON.stringify({
          status: 'success',
          data: {
            path: safePath,
            type: 'directory',
            message: `目录已创建：${safePath}`,
          },
        });
      }

      const content: string = args.content ?? '';
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, content, 'utf-8');
      const stat = await fs.stat(safePath);
      return JSON.stringify({
        status: 'success',
        data: {
          path: safePath,
          bytes_written: stat.size,
          size: stat.size,
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
