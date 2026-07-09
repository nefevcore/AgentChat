// ============================================================
// bash 工具 —— 执行 Shell 命令
//
// 设计原则（参考 pi 的 bash 设计）：
//   1. spawn 流式输出，非 exec 缓冲 —— 实时进度 + 进程树管理
//   2. tailTruncation —— 保留末尾输出（错误/结果在尾部）
//   3. fullOutputPath —— 截断时写完整输出到临时文件，让 LLM 可 read
//   4. killProcessTree —— 超时/取消时杀掉整个进程树
//   5. BashOperations 可插拔 —— 支持本地/Docker/SSH 后端
//   6. 危险命令检测 —— 拦截 rm -rf / 等明显破坏性命令
// ============================================================

import { randomBytes } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Tool } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';
import {
  type BashOperations,
  type BashExecResult,
  createLocalBashOperations,
} from './bash-process';
import { resolveBashConfig } from './config';

// ============================================================
// 截断常量
// ============================================================

/** 获取当前生效的截断配置 */
function getTruncationConfig() {
  const cfg = resolveBashConfig();
  return {
    maxLines: 2000, // 行数限制保持硬编码（与模型上下文相关）
    maxBytes: cfg.outputMaxLen,
  };
}

// ============================================================
// 临时文件 & 截断
// ============================================================

function getTempFilePath(): string {
  const id = randomBytes(8).toString('hex');
  return join(tmpdir(), `agentchat-bash-${id}.log`);
}

/**
 * tailTruncation：保留末尾而非开头。
 * bash 命令的关键信息（错误、结果、summary）通常在末尾。
 */
function applyTailTruncation(
  text: string,
  maxLines: number,
  maxBytes: number,
): { output: string; truncated: boolean; truncatedBy: 'lines' | 'bytes' | null } {
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  const lines = text.split('\n');

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { output: text, truncated: false, truncatedBy: null };
  }

  // 从后往前累积行
  const keptLines: string[] = [];
  let keptBytes = 0;
  let truncatedBy: 'lines' | 'bytes' | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8');
    const newlineBytes = i < lines.length - 1 ? 1 : 0;

    if (keptLines.length >= maxLines) {
      truncatedBy = 'lines';
      break;
    }

    if (keptBytes + lineBytes + newlineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }

    keptLines.unshift(lines[i]);
    keptBytes += lineBytes + newlineBytes;
  }

  const prefix = `[截断] 省略了前 ${lines.length - keptLines.length} 行` +
    `（${((totalBytes - keptBytes) / 1024).toFixed(1)}KB），以下是末尾 ${keptLines.length} 行：\n\n`;

  return {
    output: prefix + keptLines.join('\n'),
    truncated: true,
    truncatedBy,
  };
}

// ============================================================
// 危险命令检测
// ============================================================

const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~(\s|$)/,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\//,
  /:\s*\(\)\s*\{.*:\|:.*&.*\}/, // fork bomb
];

function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `危险命令已被阻止："${command}"`;
    }
  }
  return null;
}

// ============================================================
// 工具定义
// ============================================================

export const tool: Tool = {
  displayName: '终端',
  description: '执行 Shell 命令。',

  extractLabel: (args) => {
    const cmd = args.command || '';
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  },

  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 Shell 命令。有专用工具时优先使用专用工具。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令。',
          },
          timeout: {
            type: 'number',
            description: '超时毫秒数，默认 30000。',
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    const command: string = args.command;
    const gCfg = getGlobalConfig();
    const timeout: number | undefined = args.timeout;

    // 安全检查
    const dangerMsg = isDangerousCommand(command);
    if (dangerMsg) {
      return JSON.stringify({
        status: 'error',
        data: { command, message: dangerMsg },
      });
    }

    // 收集输出
    const chunks: Buffer[] = [];
    const ops: BashOperations = createLocalBashOperations();

    try {
      const result: BashExecResult = await ops.exec(
        command,
        gCfg.workspaceDir,
        {
          onData: (data: Buffer) => chunks.push(data),
          timeout,
        },
      );

      const fullOutput = Buffer.concat(chunks).toString('utf-8');
      const fullBytes = Buffer.byteLength(fullOutput, 'utf-8');

      // tailTruncation
      const { maxLines, maxBytes } = getTruncationConfig();
      const { output, truncated, truncatedBy } = applyTailTruncation(
        fullOutput,
        maxLines,
        maxBytes,
      );

      // 如果被截断，写完整输出到临时文件
      let fullOutputPath: string | undefined;
      if (truncated) {
        fullOutputPath = getTempFilePath();
        await writeFile(fullOutputPath, fullOutput, 'utf-8');
        // 注：临时文件不主动清理，由 OS 或后续维护清理
      }

      const success = result.exitCode === 0;

      return JSON.stringify({
        status: success ? 'success' : 'error',
        data: {
          command,
          cwd: gCfg.workspaceDir,
          output,
          exit_code: result.exitCode,
          success,
          truncated,
          truncated_by: truncatedBy,
          total_bytes: fullBytes,
          full_output_path: fullOutputPath,
          timed_out: result.timedOut,
        },
      });
    } catch (err: any) {
      // timeout 错误格式：timeout:30000
      const isTimeout = err.message?.startsWith('timeout:');
      const timeoutValue = isTimeout
        ? parseInt(err.message.split(':')[1], 10)
        : undefined;

      return JSON.stringify({
        status: 'error',
        data: {
          command,
          message: isTimeout
            ? `命令在 ${(timeoutValue ?? 0) / 1000} 秒后超时。尝试简化命令或增大 timeout 参数。`
            : err.message,
          timed_out: isTimeout,
          ...(isTimeout && timeoutValue ? { timeout_ms: timeoutValue } : {}),
        },
      });
    }
  },
};
