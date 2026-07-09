// ============================================================
// bash-process.ts —— bash 工具底层进程管理
//
// 职责：
//   1. spawn 子进程（流式输出，非 exec 缓冲）
//   2. 跨平台进程树杀灭（Windows: taskkill /F /T, Unix: pgrep + kill）
//   3. 超时处理（先杀进程树，再 reject）
//   4. 工作目录校验
//   5. Windows 特殊处理（windowsHide、UTF-8 编码）
// ============================================================

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';
import { resolveBashConfig } from './config';

// ============================================================
// 接口
// ============================================================

export interface BashExecOptions {
  /** 输出数据回调（stdout + stderr 合并） */
  onData: (data: Buffer) => void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 超时（毫秒） */
  timeout?: number;
  /** 额外环境变量 */
  env?: NodeJS.ProcessEnv;
}

export interface BashExecResult {
  /** 退出码，null 表示进程被 kill（超时或取消） */
  exitCode: number | null;
  /** 是否超时 */
  timedOut: boolean;
}

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: BashExecOptions,
  ) => Promise<BashExecResult>;
}

// ============================================================
// 跨平台进程树杀灭
// ============================================================

/** 杀灭整个进程树 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // Windows: taskkill /F /T 会杀掉进程及其所有子进程
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // 忽略 taskkill 本身失败
    }
  } else {
    // Unix: 先获取所有子进程，再一起 kill
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 进程可能已经退出
    }
  }
}

// ============================================================
// Shell 配置
// ============================================================

interface ShellConfig {
  shell: string;
  args: string[];
}

function getShellConfig(): ShellConfig {
  if (process.platform === 'win32') {
    return {
      shell: 'powershell.exe',
      args: ['-NoProfile', '-Command'],
    };
  }
  return {
    shell: '/bin/bash',
    args: ['-c'],
  };
}

// ============================================================
// 本地执行后端
// ============================================================

export function createLocalBashOperations(): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      return new Promise<BashExecResult>((resolve, reject) => {
        // 工作目录校验
        if (!existsSync(cwd)) {
          reject(new Error(`工作目录不存在：${cwd}`));
          return;
        }

        const { shell, args: shellArgs } = getShellConfig();

        // Windows PowerShell: 强制 UTF-8 输出编码
        let actualCommand = command;
        if (process.platform === 'win32') {
          actualCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
        }

        const spawnOptions: SpawnOptions = {
          cwd,
          detached: true,
          windowsHide: true, // Windows 下隐藏控制台窗口
          env: env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false, // 显式传 shell 路径和参数
        };

        const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], spawnOptions);

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        // ---- 超时处理 ----
        const bashCfg = resolveBashConfig();
        const effectiveTimeout = timeout ?? bashCfg.defaultTimeout;
        const maxTimeout = bashCfg.maxTimeout;

        if (effectiveTimeout > 0) {
          const clampedTimeout = Math.min(effectiveTimeout, maxTimeout);
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, clampedTimeout);
        }

        // ---- 流式输出 ----
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        // ---- AbortSignal ----
        if (signal) {
          const onAbort = () => {
            if (child.pid) killProcessTree(child.pid);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // ---- 进程退出 ----
        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);

          if (timedOut) {
            reject(new Error(`timeout:${effectiveTimeout}`));
          } else if (signal?.aborted) {
            resolve({ exitCode: null, timedOut: false });
          } else {
            resolve({ exitCode: code, timedOut: false });
          }
        });

        // ---- 进程错误 ----
        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });
      });
    },
  };
}
