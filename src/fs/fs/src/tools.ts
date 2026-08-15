// ============================================================
// @agentchat/fs —— 文件读写工具（read/write）
// 迁移自 tools/files.ts（read/write 部分）；领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { defineTool, resolveSafePath } from '@agentchat/toolkit';
import { makeEditTool, recordSnapshot, computeFileHash, formatNumberedLine, formatHashlineHeader } from '@agentchat/edit';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

export function makeReadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'read', label: '读取文件', requires: ['agent'],
    description: '读取文件内容或列出目录。文件默认启用 Hashline v2 格式（[PATH#TAG] 头 + 行号:内容），配合 edit 的 SWAP/INS 操作精确定位。目录返回 JSON 列表（name+type，目录在前）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径（相对工作区）' },
        lineHash: { type: 'boolean', description: '是否启用 Hashline v2 格式（[PATH#TAG] 头 + 行号:内容）。默认 true。设 false 仅输出行号:内容（无 TAG 头）。' },
      },
      required: ['path'],
    },
    execute: async ({ path: p, lineHash }) => {
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

      // Hashline v2：文件级哈希 TAG + 行号:内容
      const fileTag = computeFileHash(content);
      recordSnapshot(file, content);
      const useHash = lineHash !== false;
      const numberedLines = lines.map((l, idx) => formatNumberedLine(idx + 1, l));
      let outputContent = numberedLines.join('\n');
      if (useHash) {
        outputContent = formatHashlineHeader(p, fileTag) + '\n' + outputContent;
      }
      return JSON.stringify({
        status: 'success',
        data: {
          path: p,
          content: outputContent,
          size: stat.size,
          total_lines: lines.length,
          file_tag: fileTag,
        },
      });
    },
    extractLabel: (args) => args.path,
  });
}

/** 写入文件工具 */
export function makeWriteTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'write', label: '写入文件', requires: ['agent'],
    description: '写入/覆盖文本文件（自动创建父目录，受沙箱限制）。⚠️ 会整体覆盖已有文件内容：修改现有文件请优先用 edit（行级定位），新建文件才用 write。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        content: { type: 'string', description: '文件内容（将整体覆盖已有内容）' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path: p, content }) => {
      const file = resolveSafePath(config, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf-8');
      recordSnapshot(file, content); // write 后同步 hashline 快照，避免后续 edit 用新 TAG 被误拒（P0-2 回归）
      return JSON.stringify({ status: 'ok', data: { message: `已写入 ${p}` } });
    },
    extractLabel: (args) => args.path,
  });
}

/** 编辑文件工具（Hashline v2 完整实现，见 edit/tool.ts）
 * 支持：
 *   - input: Hashline DSL patch 字符串（[PATH#TAG] 头 + SWAP/INS 操作）
 *   - edits: JSON 数组（行号#哈希 / 裸行号 / oldText 模糊匹配）
 *   - 兼容旧格式：顶层 filePath + oldString/newString */
export { makeEditTool };

/** bash 临时日志文件前缀（background 模式日志；>1 小时清理） */

/** 文件工具族（read + write） */
export function makeFileTools(config: AgentConfig): Tool[] {
  return [makeReadTool(config), makeWriteTool(config)];
}
