// ============================================================
// read 工具 —— 读取文件内容 / 列出目录
//
// Hashline v2 格式（参考 oh-my-pi）：
//   - 输出 [PATH#TAG] 头部（文件级内容哈希）
//   - 行号格式：行号:内容（纯数字，配合 edit DSL 的 SWAP/INS 操作）
//   - 读取时自动记录快照，edit 时验证 TAG
//
// 设计原则：
//   1. offset + limit 分页读取，避免 LLM 一次加载整个大文件
//   2. 双重截断保护：行数上限 + 字节数上限，先触发的生效
//   3. 截断后续读提示：告知 LLM 剩余行数/字节，引导增量读取
//   4. 单行超长保护：首行即超限时不再截半行，提示用其他方式读取
//   5. lineHash=false 可关闭 Hashline 头部（纯行号输出）
// ============================================================

import * as fs from 'fs/promises';
import { Tool } from '@core/types';
import { getGlobalConfig, resolveNamespaceConfig, resolveSafePath } from '@agents/config';
import { meta } from './meta';
import {
  computeFileHash,
  formatHashlineHeader,
  formatNumberedLine,
} from '../shared';
import { recordSnapshot } from '../edit/hashline-snapshot';

// ── 运行时配置解析（原 config.ts） ──
export interface ReadConfig { maxLines: number; maxBytes: number; }
function defaults(): ReadConfig { return { maxLines: 2000, maxBytes: 50 * 1024 }; }
export function resolveReadConfig(runtimeCfg?: Record<string, Record<string, unknown>>): ReadConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeCfg);
}

// ============================================================
// 截断常量（已移至 config.ts，此处保留兼容）
// ============================================================

/** 读取配置（每次重新解析，支持运行时热更新） */
function getReadCfg() {
  return resolveReadConfig();
}

// ============================================================
// 路径安全（使用共享工具，支持路径白名单）
// ============================================================

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
}

/**
 * 对内容应用双重截断（行数 + 字节数），先触发的生效。
 * 如果第一行就超过字节限制，标记 firstLineExceedsLimit 而不截断半行。
 */
function applyDualTruncation(
  content: string,
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  // 如果第一行就超过字节限制，不截断半行
  const firstLineBytes = Buffer.byteLength(lines[0], 'utf-8');
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    };
  }

  let outputLines = 0;
  let outputBytes = 0;
  let truncatedBy: 'lines' | 'bytes' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8');
    const newlineBytes = i < lines.length - 1 ? 1 : 0; // '\n' separator

    // 行数限制
    if (i >= maxLines) {
      truncatedBy = 'lines';
      break;
    }

    // 字节数限制
    if (outputBytes + lineBytes + newlineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }

    outputBytes += lineBytes + newlineBytes;
    outputLines++;
  }

  const selectedLines = lines.slice(0, outputLines);
  const truncated = truncatedBy !== null;

  return {
    content: selectedLines.join('\n'),
    truncated,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes: truncated ? outputBytes : totalBytes,
    firstLineExceedsLimit: false,
  };
}

/** 生成续读提示 */
function formatContinuationHint(
  result: TruncationResult,
  startLine: number,
): string {
  if (!result.truncated && startLine === 1) return '';

  const parts: string[] = [];

  if (result.truncated) {
    parts.push(
      `[截断] 已显示 ${result.outputLines}/${result.totalLines} 行` +
      `（${(result.outputBytes / 1024).toFixed(1)}KB / ${(result.totalBytes / 1024).toFixed(1)}KB），` +
      `截断原因：${result.truncatedBy === 'lines' ? '行数超限' : '字节数超限'}。`
    );
    parts.push(
      `续读提示：使用 startLine=${startLine + result.outputLines} 继续读取后续内容。`
    );
  }

  if (result.firstLineExceedsLimit) {
    const cfg = getReadCfg();
    parts.push(
      `[警告] 文件首行即超过 ${(cfg.maxBytes / 1024).toFixed(0)}KB 限制，` +
      `无法截断显示。建议使用 bash 工具配合 head/tail 分段读取。`
    );
  }

  return parts.join('\n');
}

// ============================================================
// 工具定义
// ============================================================

export const tool: Tool = {
  ...meta,

  extractLabel: (args) => args.filePath || '',

  definition: {
    type: 'function',
    function: {
      name: 'read',
      description: '读取文件内容或列出目录结构。默认启用 Hashline v2 格式（[PATH#TAG] 头 + 行号:内容），配合 edit 的 SWAP/INS 操作精确定位。',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件或目录路径。',
          },
          startLine: {
            type: 'number',
            description: '起始行号（1-based），默认 1。',
          },
          endLine: {
            type: 'number',
            description: '结束行号（1-based），默认文件末尾。',
          },
          lineHash: {
            type: 'boolean',
            description: '是否启用 Hashline v2 格式（[PATH#TAG] 头部 + 行号:内容）。默认 true。设为 false 仅输出行号:内容（无 TAG 头部）。',
          },
        },
        required: ['filePath'],
      },
    },
  },

  async execute(args: Record<string, any>, stream): Promise<string> {
    try {
      const safePath = resolveSafePath(args.filePath);
      const stat = await fs.stat(safePath);

      // ---- 目录：返回文件清单 ----
      if (stat.isDirectory()) {
        stream?.onChunk?.(`正在列出目录: ${args.filePath}...\n`);
        const entries = await fs.readdir(safePath, { withFileTypes: true });
        const items = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }));
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        stream?.onChunk?.(`找到 ${items.length} 个项目\n`);
        return JSON.stringify({
          status: 'success',
          data: { path: safePath, type: 'directory', items, count: items.length },
        });
      }

      // ---- 文件：读取内容 ----
      stream?.onChunk?.(`正在读取: ${args.filePath} (${(stat.size / 1024).toFixed(1)}KB)...\n`);
      const content = await fs.readFile(safePath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      // 行范围处理
      const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
      const endLine = typeof args.endLine === 'number' ? args.endLine : totalLines;
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

      const isRange = start > 1 || end < totalLines;
      const selectedLines = lines.slice(start - 1, end);

      // Hashline v2 格式：[PATH#TAG] 头部 + 行号:内容
      // 计算文件级哈希（用于 edit 验证文件版本）
      const fileTag = computeFileHash(content);
      const displayPath = args.filePath;

      // 记录快照（供 edit 验证）
      recordSnapshot(safePath, content);

      const useHash = args.lineHash !== false; // 默认开启
      const numberedLines = selectedLines.map((l, idx) => formatNumberedLine(start + idx, l));
      let outputContent = numberedLines.join('\n');

      // 仅在完整读取（非范围）时添加 Hashline 头部
      if (useHash && !isRange) {
        outputContent = formatHashlineHeader(displayPath, fileTag) + '\n' + outputContent;
      }

      // 双重截断
      const cfg = getReadCfg();
      const truncation = applyDualTruncation(
        outputContent,
        cfg.maxLines,
        cfg.maxBytes,
      );

      // 续读提示
      const hint = formatContinuationHint(truncation, start);

      if (truncation.truncated) {
        stream?.onChunk?.(
          `已读取 ${truncation.outputLines}/${truncation.totalLines} 行` +
          `（${(truncation.outputBytes / 1024).toFixed(1)}KB / ${(truncation.totalBytes / 1024).toFixed(1)}KB）\n`
        );
      }

      return JSON.stringify({
        status: 'success',
        data: {
          path: safePath,
          content: truncation.firstLineExceedsLimit ? null : truncation.content,
          size: stat.size,
          truncated: truncation.truncated,
          truncated_by: truncation.truncatedBy,
          total_lines: truncation.totalLines,
          total_bytes: truncation.totalBytes,
          output_lines: truncation.outputLines,
          output_bytes: truncation.outputBytes,
          first_line_exceeds_limit: truncation.firstLineExceedsLimit,
          hint: hint || undefined,
          file_tag: fileTag,
          ...(isRange ? { start_line: start, end_line: end } : {}),
        },
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: { path: args.filePath, message: err.message },
      });
    }
  },
};
