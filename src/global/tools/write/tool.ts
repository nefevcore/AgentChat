// ============================================================
// write 工具 —— 写入文件 / 创建目录
// 路径防御：强制限制在工作区目录内
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';
import { meta } from './meta';

// ============================================================
// 路径安全
// ============================================================

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

// ============================================================
// 路径阻塞检测
//
// 当 fs.mkdir(..., { recursive: true }) 遇到中间路径是文件时，
// 会抛出 ENOTDIR 且错误消息指向该文件而非目标路径，非常令人困惑。
// 此函数提前检测这种情况并生成清晰的错误消息。
// ============================================================

/**
 * 从目标路径向上遍历，检测是否有文件阻塞了目录/文件创建。
 * 返回阻塞该路径的文件路径（如果有），否则返回 null。
 */
async function findBlockingFile(targetPath: string): Promise<string | null> {
  let current = path.normalize(targetPath);
  const sandbox = path.resolve(getGlobalConfig().workspaceDir);

  while (true) {
    const parent = path.dirname(current);
    // 到达根目录或工作区根目录则停止
    if (parent === current || parent === sandbox || !parent.startsWith(sandbox)) {
      break;
    }
    try {
      const stat = await fs.stat(parent);
      if (!stat.isDirectory()) {
        return parent; // 这个路径是文件，阻塞了更深层的创建
      }
      break; // 找到了目录，父级不再检查
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // 该路径不存在，继续向上检查
        current = parent;
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * 确保目标路径及其所有父目录可以被创建。
 * 如果有文件阻塞路径，抛出友好的错误。
 *
 * @param targetPath  要创建的最终路径（文件路径或目录路径）
 * @param isDirectory 是否创建目录（true）还是文件（false）
 */
async function ensurePathClear(targetPath: string, isDirectory: boolean): Promise<void> {
  const blockingFile = await findBlockingFile(targetPath);
  if (blockingFile) {
    const targetType = isDirectory ? '目录' : '文件';
    throw new Error(
      `无法创建${targetType} "${targetPath}"：` +
      `父路径 "${blockingFile}" 是一个文件而非目录，` +
      `请先删除该文件或使用其他路径。`
    );
  }
}

// ============================================================
// 工具定义
// ============================================================

/** 文件写入 / 目录创建工具，内置路径穿越防御与阻塞检测 */
export const tool: Tool = {
  ...meta,
  extractLabel: (args) => args.filePath || '',
  definition: {
    type: 'function',
    function: {
      name: 'write',
      description: '将内容写入文件或创建目录。',
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

  async execute(args: Record<string, any>, stream): Promise<string> {
    try {
      stream?.onChunk?.(`正在写入: ${args.filePath}...\n`);
      const safePath = safeResolve(args.filePath);

      // 以 / 结尾表示创建目录
      if (args.filePath.endsWith('/') || args.filePath.endsWith('\\')) {
        await ensurePathClear(safePath, true);
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
      await ensurePathClear(path.dirname(safePath), false);
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, content, 'utf-8');
      const stat = await fs.stat(safePath);
      stream?.onChunk?.(`写入完成 (${stat.size} bytes)\n`);
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
