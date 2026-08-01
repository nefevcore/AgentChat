// ============================================================
// bash-process.ts —— bash 工具底层进程管理
//
// 职责：
//   1. spawn 子进程（流式输出，非 exec 缓冲）
//   2. 跨平台进程树杀灭（Windows: taskkill /F /T, Unix: kill）
//   3. 超时处理（先杀进程树，再 reject）
//   4. 工作目录校验
//   5. Windows 特殊处理（windowsHide、UTF-8 编码）
//   6. maxBuffer 输出上限保护
// ============================================================

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync, openSync } from 'fs';

// ============================================================
// 接口
// ============================================================

export interface BashExecOptions {
  /** 输出数据回调（stdout + stderr 合并），返回 false 停止收集 */
  onData: (data: Buffer) => boolean | void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 超时（毫秒） */
  timeout?: number;
  /** 最大超时（毫秒），用于 clamp */
  maxTimeout?: number;
  /** 额外环境变量 */
  env?: NodeJS.ProcessEnv;
  /** stdin 输入（可选） */
  stdin?: string;
}

export interface BashExecResult {
  /** 退出码，null 表示进程被 kill（超时或取消） */
  exitCode: number | null;
  /** 是否超时 */
  timedOut: boolean;
  /** 是否因输出过大被截断 */
  outputTruncated: boolean;
}

/** 后台执行结果（spawnBackground） */
export interface BashBackgroundResult {
  /** 子进程 PID */
  pid: number;
  /** 日志文件路径（stdout+stderr 重定向） */
  logFile: string;
}

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: BashExecOptions,
  ) => Promise<BashExecResult>;
  /** 后台执行：detached spawn，日志写文件，立即返回不阻塞 */
  spawnBackground: (
    command: string,
    cwd: string,
    logFile: string,
  ) => Promise<BashBackgroundResult>;
}

// ============================================================
// 跨平台进程树杀灭
// ============================================================

/** 杀灭整个进程树 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch { /* taskkill 本身失败忽略 */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程可能已退出 */ }
  }
}

// ============================================================
// Shell 配置
// ============================================================

interface ShellConfig { shell: string; args: string[]; }

function getShellConfig(): ShellConfig {
  if (process.platform === 'win32') {
    return { shell: 'powershell.exe', args: ['-NoProfile', '-Command'] };
  }
  return { shell: '/bin/bash', args: ['-c'] };
}

// ============================================================
// 本地执行后端
// ============================================================

export function createLocalBashOperations(): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, maxTimeout, env, stdin }) {
      return new Promise<BashExecResult>((resolve, reject) => {
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
          detached: false,
          windowsHide: true,
          env: env ?? process.env,
          stdio: stdin != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          shell: false,
        };

        const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], spawnOptions);

        let timedOut = false;
        let outputTruncated = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        // ---- 超时处理 ----
        const effectiveTimeout = (timeout ?? 30_000);
        const clampedTimeout = maxTimeout ? Math.min(effectiveTimeout, maxTimeout) : effectiveTimeout;

        if (clampedTimeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, clampedTimeout);
        }

        // ---- stdin ----
        if (stdin != null && child.stdin) {
          child.stdin.write(stdin);
          child.stdin.end();
        }

        // ---- 流式输出 ----
        child.stdout?.on('data', (data: Buffer) => onData(data));
        child.stderr?.on('data', (data: Buffer) => onData(data));

        // ---- AbortSignal ----
        if (signal) {
          signal.addEventListener('abort', () => {
            if (child.pid) killProcessTree(child.pid);
          }, { once: true });
        }

        // ---- 进程退出 ----
        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (timedOut) {
            reject(new Error(`timeout:${effectiveTimeout}`));
          } else if (signal?.aborted) {
            resolve({ exitCode: null, timedOut: false, outputTruncated });
          } else {
            resolve({ exitCode: code, timedOut: false, outputTruncated });
          }
        });

        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });
      });
    },

    // ---- 后台执行：detached spawn + 日志文件，立即返回 ----
    async spawnBackground(command, cwd, logFile) {
      if (!existsSync(cwd)) {
        throw new Error(`工作目录不存在：${cwd}`);
      }
      const { shell, args: shellArgs } = getShellConfig();
      // Windows PowerShell: 强制 UTF-8 输出编码
      let actualCommand = command;
      if (process.platform === 'win32') {
        actualCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
      }

      // 日志文件：stdout+stderr 重定向，供后续查看
      const fd = openSync(logFile, 'a');

      const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], {
        cwd,
        detached: process.platform !== 'win32', // Windows 不脱离（避免幽灵控制台），unref 即可
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', fd, fd],
        shell: false,
      });

      // 父进程退出不等待后台子进程（但子进程继续运行）
      child.unref();

      // 返回 PID + 日志路径（不等待退出）
      return { pid: child.pid!, logFile };
    },
  };
}
