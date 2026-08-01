// ============================================================
// bash 工具 —— 执行 Shell 命令
//
// 设计原则（参考 pi 的 bash 设计）：
//   1. spawn 流式输出，非 exec 缓冲 —— 实时进度 + 进程树管理
//   2. tailTruncation —— 保留末尾输出（错误/结果在尾部）
//   3. fullOutputPath —— 截断时写完整输出到临时文件
//   4. killProcessTree —— 超时/取消时杀掉整个进程树
//   5. BashOperations 可插拔 —— 支持本地/Docker/SSH 后端
//   6. 危险命令检测 —— 拦截 POSIX + PowerShell + 管道注入
//   7. maxBuffer 保护 —— 防止 OOM
//   8. 友好错误指导 —— 根据 exit code 给出具体建议
// ============================================================

import { randomBytes } from 'crypto';
import { writeFile, unlink, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Tool } from '@core/types';
import { getGlobalConfig, resolveNamespaceConfig } from '@core/config';
import { meta } from './meta';
import {
  type BashOperations,
  type BashExecResult,
  createLocalBashOperations,
} from './bash-process';

// ── 运行时配置 ──

export interface BashConfig {
  defaultTimeout: number; maxTimeout: number;
  outputMaxLen: number; maxBuffer: number;
}

function defaults(): BashConfig {
  return { defaultTimeout: 30_000, maxTimeout: 120_000, outputMaxLen: 50_000, maxBuffer: 10 * 1024 * 1024 };
}

export function resolveBashConfig(runtimeCfg?: Record<string, Record<string, unknown>>): BashConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeCfg);
}

// ── 临时文件 ──

const TEMP_PREFIX = 'agentchat-bash-';

function getTempFilePath(): string {
  return join(tmpdir(), `${TEMP_PREFIX}${randomBytes(8).toString('hex')}.log`);
}

/** 清理超过 1 小时的旧临时文件 */
async function cleanupOldTempFiles(): Promise<void> {
  try {
    const files = await readdir(tmpdir());
    const now = Date.now();
    for (const f of files) {
      if (!f.startsWith(TEMP_PREFIX)) continue;
      // 简单策略：超过 1 小时的清理（无法获取 ctime 则跳过）
      try {
        const { stat } = await import('fs/promises');
        const s = await stat(join(tmpdir(), f));
        if (now - s.birthtimeMs > 3_600_000) {
          await unlink(join(tmpdir(), f)).catch(() => {});
        }
      } catch { /* 跳过无法 stat 的文件 */ }
    }
  } catch { /* 非关键路径 */ }
}

// ── 截断 ──

function applyTailTruncation(
  text: string, maxLines: number, maxBytes: number,
): { output: string; truncated: boolean; truncatedBy: 'lines' | 'bytes' | null } {
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  const lines = text.split('\n');
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { output: text, truncated: false, truncatedBy: null };
  }
  const keptLines: string[] = [];
  let keptBytes = 0;
  let truncatedBy: 'lines' | 'bytes' | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lb = Buffer.byteLength(lines[i], 'utf-8');
    const nb = i < lines.length - 1 ? 1 : 0;
    if (keptLines.length >= maxLines) { truncatedBy = 'lines'; break; }
    if (keptBytes + lb + nb > maxBytes) { truncatedBy = 'bytes'; break; }
    keptLines.unshift(lines[i]);
    keptBytes += lb + nb;
  }
  const prefix = `[截断] 省略了前 ${lines.length - keptLines.length} 行（${((totalBytes - keptBytes) / 1024).toFixed(1)}KB），以下是末尾 ${keptLines.length} 行：\n\n`;
  return { output: prefix + keptLines.join('\n'), truncated: true, truncatedBy };
}

// ── 危险命令检测 ──

const DANGEROUS_PATTERNS: { pattern: RegExp; desc: string }[] = [
  // POSIX
  { pattern: /rm\s+-rf\s+\//,                              desc: 'rm -rf /' },
  { pattern: /rm\s+-rf\s+~(\s|$)/,                         desc: 'rm -rf ~' },
  { pattern: /rm\s+-rf\s+\$HOME/,                          desc: 'rm -rf \$HOME' },
  { pattern: /mkfs\./,                                     desc: 'mkfs' },
  { pattern: /dd\s+if=.*of=\/dev\//,                       desc: 'dd to /dev' },
  { pattern: />\s*\/dev\/sd/,                              desc: '写入块设备' },
  { pattern: /:\s*\(\)\s*\{.*:\|.*:\s*&\s*\}.*;.*:/,      desc: 'fork bomb' },
  // 管道注入
  { pattern: /curl.*\|.*(ba)?sh/,                          desc: 'curl | sh' },
  { pattern: /wget.*-O\s*-\s*\|.*(ba)?sh/,                 desc: 'wget | sh' },
  // Windows
  { pattern: /Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\/, desc: 'Remove-Item 盘符' },
  { pattern: /rmdir\s+\/S\s+\/Q\s+[A-Z]:\\/,               desc: 'rmdir 盘符' },
  { pattern: /del\s+\/F\s+\/S\s+[A-Z]:\\/,                 desc: 'del 盘符' },
  { pattern: /format\s+[A-Z]:/,                            desc: 'format' },
  { pattern: /diskpart/,                                   desc: 'diskpart' },
];

function isDangerousCommand(command: string): string | null {
  for (const { pattern, desc } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `危险命令已阻止：${desc}。如确需执行，请手动在终端操作。`;
    }
  }
  return null;
}

// ── 友好错误指导 ──

function formatFailureGuidance(
  command: string, exitCode: number | null, output: string,
  timedOut: boolean, truncated: boolean,
): string {
  const lines: string[] = [];

  if (timedOut) {
    lines.push('💡 命令超时。建议：');
    lines.push('  1. 增大 timeout 参数（如 timeout=60000）');
    lines.push('  2. 简化命令（减少处理数据量）');
    lines.push('  3. 分步执行（将长任务拆为多个短命令）');
    return lines.join('\n');
  }

  // 分析输出中的常见错误
  const lower = output.toLowerCase();

  if (lower.includes('command not found') || lower.includes('不是内部或外部命令') || lower.includes('is not recognized')) {
    const cmdName = command.split(/\s+/)[0];
    if (process.platform === 'win32') {
      lines.push(`💡 命令 "${cmdName}" 未找到。建议：`);
      lines.push('  1. 检查是否拼写错误');
      lines.push('  2. PowerShell 中某些 cmd 命令需用 `cmd /c` 前缀（如 `cmd /c dir`）');
      lines.push('  3. 安装缺失的工具（如 `winget install ...`）');
    } else {
      lines.push(`💡 命令 "${cmdName}" 未找到。建议：`);
      lines.push('  1. 检查是否拼写错误');
      lines.push('  2. 使用 `which <命令>` 确认安装路径');
      lines.push('  3. 安装缺失的包（如 `apt install ...` 或 `brew install ...`）');
    }
    return lines.join('\n');
  }

  if (lower.includes('permission denied') || lower.includes('eacces') || lower.includes('拒绝访问')) {
    lines.push('💡 权限不足。建议：');
    lines.push('  1. 检查文件/目录权限（`ls -la` 或 `icacls`）');
    lines.push('  2. 确认工作目录是否正确');
    lines.push('  3. 避免操作系统保护目录（如 C:\\Windows、/etc）');
    return lines.join('\n');
  }

  if (lower.includes('no such file') || lower.includes('cannot find') || lower.includes('找不到') || lower.includes('系统找不到')) {
    lines.push('💡 文件或目录不存在。建议：');
    lines.push('  1. 使用 read 工具确认文件路径');
    lines.push('  2. 检查路径拼写和大小写（Windows 不区分，Linux 区分）');
    lines.push('  3. 使用绝对路径替代相对路径');
    return lines.join('\n');
  }

  if (truncated) {
    lines.push('💡 输出被截断。建议：');
    lines.push('  1. 使用 read 工具读取完整输出文件（full_output_path）');
    lines.push('  2. 添加过滤条件减少输出（如 `| Select-Object -First 100` 或 `| head -100`）');
    return lines.join('\n');
  }

  if (exitCode !== null && exitCode !== 0) {
    lines.push(`💡 命令退出码 ${exitCode}。建议：`);
    lines.push('  1. 检查命令语法是否正确');
    lines.push('  2. 确认所有依赖文件/工具已就绪');
    lines.push('  3. 尝试分步执行以定位失败步骤');
  }

  return lines.join('\n');
}

// ============================================================
// 工具定义
// ============================================================

export const tool: Tool = {
  ...meta,

  extractLabel: (args) => {
    const cmd = args.command || '';
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  },

  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 Shell 命令（Windows: PowerShell，Linux/macOS: bash）。支持 stdin 输入。输出超限时保留末尾（错误通常在尾部）并写入临时文件供 read 查看。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令。Windows 用 PowerShell 语法，Linux/macOS 用 bash 语法。',
          },
          timeout: {
            type: 'number',
            description: '超时毫秒数，默认 30000，最大 120000。',
          },
          stdin: {
            type: 'string',
            description: '传递给命令的标准输入（可选）。用于 sudo、passwd 等需要输入的命令。',
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args: Record<string, any>, stream, signal?): Promise<string> {
    const command: string = args.command;
    const gCfg = getGlobalConfig();
    const bashCfg = resolveBashConfig();
    const timeout: number | undefined = args.timeout;
    const stdin: string | undefined = args.stdin;

    // 安全检查
    const dangerMsg = isDangerousCommand(command);
    if (dangerMsg) {
      return JSON.stringify({ status: 'error', data: { command, message: dangerMsg } });
    }

    // 清理旧临时文件（非阻塞）
    cleanupOldTempFiles();

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let bufferExceeded = false;
    const ops: BashOperations = createLocalBashOperations();

    try {
      const result: BashExecResult = await ops.exec(
        command,
        gCfg.workspaceDir,
        {
          onData: (data: Buffer) => {
            // maxBuffer 保护
            if (totalBytes + data.length > bashCfg.maxBuffer) {
              bufferExceeded = true;
              return false; // 停止收集
            }
            totalBytes += data.length;
            chunks.push(data);
            stream?.onChunk?.(data.toString('utf-8'));
          },
          timeout,
          maxTimeout: bashCfg.maxTimeout,
          stdin,
          signal,
        },
      );

      const fullOutput = Buffer.concat(chunks).toString('utf-8');
      const fullBytes = Buffer.byteLength(fullOutput, 'utf-8');

      // tailTruncation
      const maxLines = 2000;
      const { output, truncated, truncatedBy } = applyTailTruncation(
        fullOutput,
        maxLines,
        bashCfg.outputMaxLen,
      );

      // 截断或 buffer 溢出 → 写完整输出到临时文件
      let fullOutputPath: string | undefined;
      if (truncated || bufferExceeded) {
        fullOutputPath = getTempFilePath();
        await writeFile(fullOutputPath, fullOutput, 'utf-8');
      }

      const success = result.exitCode === 0 && !bufferExceeded;
      const guidance = success ? undefined : formatFailureGuidance(
        command, result.exitCode, fullOutput, result.timedOut, truncated || bufferExceeded,
      );

      return JSON.stringify({
        status: success ? 'success' : 'error',
        data: {
          command,
          cwd: gCfg.workspaceDir,
          output,
          exit_code: result.exitCode,
          success,
          truncated: truncated || bufferExceeded,
          truncated_by: truncatedBy ?? (bufferExceeded ? 'buffer' : null),
          total_bytes: fullBytes,
          ...(bufferExceeded ? { buffer_exceeded: true } : {}),
          full_output_path: fullOutputPath,
          timed_out: result.timedOut,
          ...(guidance ? { guidance } : {}),
        },
      });
    } catch (err: any) {
      const isTimeout = err.message?.startsWith('timeout:');
      const timeoutValue = isTimeout ? parseInt(err.message.split(':')[1], 10) : undefined;
      const guidance = isTimeout
        ? '💡 命令超时。建议：1) 增大 timeout 参数  2) 简化命令  3) 分步执行。'
        : `💡 执行失败：${err.message}。建议检查命令语法和工作目录是否正确。`;

      return JSON.stringify({
        status: 'error',
        data: {
          command,
          cwd: gCfg.workspaceDir,
          message: isTimeout
            ? `命令在 ${(timeoutValue ?? 0) / 1000} 秒后超时。`
            : err.message,
          timed_out: isTimeout,
          guidance,
          ...(isTimeout && timeoutValue ? { timeout_ms: timeoutValue } : {}),
        },
      });
    }
  },
};
