// ============================================================
// bash 工具 —— 执行 Shell 命令
// 安全防御：
//   1. 强制锁定工作目录 (cwd)
//   2. 超时机制 (默认 30s)
//   3. 输出截断
// ============================================================

import { exec, ExecOptions } from 'child_process';
import { Tool } from '../../../core/types';
import { getGlobalConfig } from '../../../core/config';

function getWorkspaceRoot(): string {
  return getGlobalConfig().workspaceDir;
}

export const tool: Tool = {
  displayName: '终端',
  description: '在终端中运行命令',
  extractLabel: (args) => args.command || '',
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description: '在终端中运行命令',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 Shell 命令。',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 30000（30 秒）。',
          },
        },
        required: ['command'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    const command: string = args.command;
    const gCfg = getGlobalConfig();
    const timeout: number = args.timeout ?? gCfg.bashDefaultTimeout;

    // 安全检查：拒绝明显的危险命令
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /mkfs\./,
      /dd\s+if=/,
      />\s*\/dev\//,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return JSON.stringify({
          status: 'error',
          data: {
            command,
            message: `危险命令已被阻止："${command}"`,
          },
        });
      }
    }

    const cwd = getWorkspaceRoot();
    const options: ExecOptions = {
      cwd,
      timeout: Math.min(timeout, gCfg.bashMaxTimeout),
      maxBuffer: gCfg.bashMaxBuffer,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
    };

    // Windows PowerShell 默认使用系统代码页（中文系统为 GBK），
    // 需要显式设置输出编码为 UTF-8 以避免中文乱码
    let actualCommand = command;
    if (process.platform === 'win32') {
      actualCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
    }

    return new Promise((resolve) => {
      exec(actualCommand, options, (error, stdout, stderr) => {
        const exitCode = error?.code ?? 0;
        const success = !error;

        // 截断过长输出
        const maxLen = gCfg.bashOutputMaxLen;
        let truncated = false;
        let outStr = stdout || '';
        let errStr = stderr || '';

        if (outStr.length > maxLen) {
          outStr = outStr.slice(0, maxLen);
          truncated = true;
        }
        if (errStr.length > maxLen) {
          errStr = errStr.slice(0, maxLen);
          truncated = true;
        }

        resolve(JSON.stringify({
          status: success ? 'success' : 'error',
          data: {
            command,
            cwd,
            stdout: outStr,
            stderr: errStr,
            exit_code: exitCode,
            success,
            truncated,
            error_message: error?.message ?? null,
          },
        }));
      });
    });
  },
};
