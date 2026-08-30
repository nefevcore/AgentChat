// ============================================================
// @agentchat/fs —— 文件读写工具（read/write/edit）
// 迁移自 tools/files.ts（read/write/edit 部分）；领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { defineTool, resolveSafePath } from '@agentchat/toolkit';
import { makeEditTool } from '@agentchat/edit';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

export function makeReadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'read', label: '读取文件', requires: [CAPABILITY_BASE],
    description: '读取文本文件并返回带有行号的内容。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件或目录路径' },
        offset: { type: 'number', description: '起始行号（默认 1）', minimum: 1 },
        limit: { type: 'number', description: '最多返回的行数（默认 2000，最大 5000）', minimum: 1, maximum: 5000 },
      },
      required: ['file_path'],
    },
    execute: async ({ file_path, path: pLegacy, offset, limit }) => {
      const p = file_path ?? pLegacy;
      const file = resolveSafePath(config, p);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(file, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }));
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return JSON.stringify({ status: 'success', data: { path: p, type: 'directory', items, count: items.length } });
      }
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      const total = lines.length;

      // 分段读取（offset 1 基；limit 缺省 2000）
      const start = Math.max(1, Math.floor(Number(offset) || 1));
      const maxLines = Math.min(5000, Math.max(1, Math.floor(Number(limit) || 2000)));
      const slice = lines.slice(start - 1, start - 1 + maxLines);
      const truncated = start - 1 + maxLines < total;

      const numberedLines = slice.map((l, idx) => `${start + idx}:${l}`);
      return JSON.stringify({
        status: 'success',
        data: {
          path: p,
          content: numberedLines.join('\n'),
          size: stat.size,
          total_lines: total,
          ...(truncated ? { truncated: true, next_offset: start + maxLines } : {}),
        },
      });
    },
    extractLabel: (args) => args.file_path || args.path,
  });
}

/** 写入文件工具 */
export function makeWriteTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'write', label: '写入文件', requires: [CAPABILITY_BASE],
    description: '创建或覆盖文本文件。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['file_path', 'content'],
    },
    execute: async ({ file_path, path: pLegacy, content }) => {
      const p = file_path ?? pLegacy;
      const file = resolveSafePath(config, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf-8');
      return JSON.stringify({ status: 'ok', data: { message: `已写入 ${p}` } });
    },
    extractLabel: (args) => args.file_path || args.path,
  });
}

/** 编辑文件工具（old_string/new_string 文本匹配，见 edit/tool.ts）
 * 2026-08-20 简化：Hashline DSL / 行级定位 / edits[] 批量已移除，
 * 多处修改由 Agent 并行发多个 edit 调用承担。 */
export { makeEditTool };

/** bash 临时日志文件前缀（background 模式日志；>1 小时清理） */

/** 文件工具族（read + write + edit） */
export function makeFileTools(config: AgentConfig): Tool[] {
  return [makeReadTool(config), makeWriteTool(config), makeEditTool(config)];
}
