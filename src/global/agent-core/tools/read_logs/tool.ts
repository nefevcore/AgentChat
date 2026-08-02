// ============================================================
// read_logs 工具 —— 读取后端日志（内存环形缓冲）
//
// 背景：后端日志只输出到控制台，Agent 无法直接看到。
// 调试（如归档链路）时只能靠文件状态推断或人工复制日志。
//
// 本工具读取 logger.ts 的环形缓冲（最近 2000 条），支持：
//   · limit   返回条数（默认 100，最大 500）
//   · level   最低级别（debug/info/notice/warn/error）
//   · keyword 关键词过滤
//   · clear   清空缓冲（可选，默认 false）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { readLogs, clearLogBuffer } from '@utils/logger';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'read_logs',
      description:
        '从内存环形缓冲读取后端日志（最近 2000 条）。用于调试：按 level（debug/info/notice/warn/error）、keyword、limit 过滤。' +
        '设置 clear=true 可先清空缓冲再收集新日志。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number', description: '返回条数（默认 100，最大 500）',
          },
          level: {
            type: 'string', enum: ['debug', 'info', 'notice', 'warn', 'error'],
            description: '最低级别过滤',
          },
          keyword: {
            type: 'string', description: '关键词过滤（匹配完整日志行）',
          },
          clear: {
            type: 'boolean', description: '先清空缓冲再返回（默认 false）',
          },
        },
      },
    },
  },

  extractLabel: (args: Record<string, any>) => {
    const parts: string[] = [];
    if (args.level) parts.push(args.level);
    if (args.keyword) parts.push(`"${args.keyword}"`);
    if (args.limit) parts.push(`${args.limit}条`);
    return `📜 日志${parts.length ? ' ' + parts.join(' ') : ''}`;
  },

  execute: async (args: Record<string, any>) => {
    try {
      if (args.clear === true) {
        clearLogBuffer();
        return JSON.stringify({ status: 'ok', data: { cleared: true, message: '日志缓冲已清空' } });
      }
      const entries = readLogs({
        level: args.level,
        keyword: args.keyword,
        limit: args.limit,
      });
      const lines = entries.map(e => e.line);
      return JSON.stringify({
        status: 'ok',
        data: {
          count: lines.length,
          total_in_buffer: entries.length,
          logs: lines,
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
    }
  },
};
