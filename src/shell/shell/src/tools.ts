// ============================================================
// @agentchat/shell —— 命令执行工具（bash）
// 迁移自 tools/files.ts（bash 部分）；领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { defineTool, resolveSafePath, workspaceRoot, getAllowedPaths, NS_TOOL_BASH, type ConfigField } from '@agentchat/toolkit';
import { getNamespaceConfig, CAPABILITY_BASE } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

export const BASH_CONFIG_SCHEMA: ConfigField[] = [
  { name: 'defaultTimeout', label: '默认超时', description: '命令默认超时（秒）', type: 'number', default: 30000 },
  { name: 'maxTimeout', label: '最大超时', description: '命令允许的最大超时（秒）', type: 'number', default: 120000 },
  { name: 'outputMaxLen', label: '输出截断', description: '命令输出最大保留字符数', type: 'number', default: 50000 },
  { name: 'maxBuffer', label: '缓冲区上限', description: '命令输出缓冲区上限（字节）', type: 'number', default: 10485760 },
];

// ============================================================
// bash 底层执行器 —— Windows 优先 PowerShell 7 (pwsh)，
// 未安装回退 Windows PowerShell (powershell.exe)，再回退 cmd。
// 照搬旧 bash-process.ts 的 shell 探测 + 进程树杀 + UTF-8 编码。
// ============================================================

interface ShellConfig { shell: string; args: string[]; }

/** Windows shell 配置（pwsh 探测结果一次性缓存） */
let winShell: ShellConfig | null = null;

function getShellConfig(): ShellConfig {
  if (process.platform !== 'win32') {
    return { shell: '/bin/bash', args: ['-c'] };
  }
  if (winShell) return winShell;
  const probe = (shell: string, args: string[]): boolean => {
    try {
      const r = spawnSync(shell, args, { timeout: 3000, stdio: 'ignore', windowsHide: true });
      return r.error == null && r.status === 0;
    } catch { return false; }
  };
  // PowerShell 7 (pwsh)：引号/参数传递显著优于 Windows PowerShell 5.1
  if (probe('pwsh', ['-NoProfile', '-Command', '$true'])) {
    winShell = { shell: 'pwsh', args: ['-NoProfile', '-Command'] };
  } else if (probe('powershell.exe', ['-NoProfile', '-Command', '$true'])) {
    winShell = { shell: 'powershell.exe', args: ['-NoProfile', '-Command'] };
  } else {
    // 最后回退 cmd（Windows 必有）
    winShell = { shell: 'cmd', args: ['/d', '/s', '/c'] };
  }
  return winShell;
}

/**
 * bash 命令级沙箱（启发式静态检查）：
 * 拦截允许范围外访问 —— cd .. 越界 / 盘符绝对路径（C:\）/ Unix 绝对路径 / 独立 ../ 引用。
 * 目标路径解析后落在 allowedRoots（workspaceRoot + security.allowedPaths）内则放行，
 * 与 read/write/edit 的 resolveSafePath 白名单对齐。返回违规说明或 null（允许）。
 *
 * 注意：这是纵深防御（cwd 参数校验之外），无法覆盖全部 shell 语法，
 * 但能拦截 test 实测的越界场景：cd ..、Get-Content C:\Windows\win.ini、遍历 C:\、写工作区外文件。
 */
export function bashCommandViolation(command: string, allowedRoots?: string[]): string | null {
  const norm = command.replace(/\\/g, '/');
  const root = workspaceRoot();
  const roots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [root];
  /** 目标是否落在允许根内（与 resolveSafePath 同一判定） */
  const isAllowed = (target: string): boolean => {
    const t = path.resolve(target);
    return roots.some(r => t === r || t.startsWith(r + path.sep));
  };

  // 按命令段拆分（; && || | 换行）
  const segments = norm.split(/[;&|]|\n/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // 1. 盘符绝对路径（C:\ 或 C:/）；排除 $env: / %VAR% 变量展开（无 \ / 后缀）
    const drive = seg.match(/[A-Za-z]:[\\/]/);
    if (drive) {
      const m = seg.match(/[A-Za-z]:[\\/][^\s;|&"'`]*/);
      const p = m ? m[0] : drive[0];
      if (!isAllowed(p)) {
        return `命令包含绝对路径（${drive[0][0].toUpperCase()}:）访问，超出允许范围，被沙箱拦截。请使用工作区内相对路径`;
      }
      continue; // 盘符在白名单内 → 放行
    }
    // 2. Unix 风格绝对路径（独立路径参数，如 /etc /tmp）
    const abs = seg.match(/(?:^|\s)\/(?:[a-zA-Z0-9_.-]+)(?:\/|$)/);
    if (abs) {
      const p = abs[0].trim();
      if (!isAllowed(p)) {
        return `命令包含绝对路径（${p}）访问，超出允许范围，被沙箱拦截`;
      }
      continue; // Unix 绝对路径在白名单内 → 放行
    }
    // 3. cd 越界：cd .. / cd ../x / cd 绝对路径（目标解析后判断）
    const cd = seg.match(/\bcd\s+("?[^\s"]+"?)/);
    if (cd) {
      const target = cd[1].replace(/^["']|["']$/g, '');
      if (target === '..' || target.startsWith('../') || target.includes('..')
        || target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
        if (!isAllowed(path.resolve(root, target))) {
          return `命令中 cd 到 "${target}" 越出允许范围，被沙箱拦截。仅允许工作区及白名单内目录`;
        }
      }
    }
    // 4. 独立 ../ 引用（排除 git diff a..b 这类 token 内 ..；解析后判断）
    const refs = seg.match(/(?:^|\s)(\.\.[\\/][^\s;|&"'`]*)/g);
    if (refs) {
      for (const ref of refs) {
        const p = ref.trim();
        if (!isAllowed(path.resolve(root, p))) {
          return `命令包含 ".." 相对路径引用，可能越出允许范围，被沙箱拦截。请使用工作区内相对路径`;
        }
      }
    }
  }
  return null;
}

/** 杀整个进程树（Windows: taskkill /F /T；Unix: 负 PID kill） */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch { /* taskkill 本身失败忽略 */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程可能已退出 */ }
  }
}

/** 读取文件工具（Hashline v2：输出 [PATH#TAG] 头部 + 行号:内容，供 edit DSL 定位） */
const BASH_TEMP_PREFIX = 'agentchat-bash-';

function bashTempLogPath(): string {
  return path.join(tmpdir(), `${BASH_TEMP_PREFIX}${randomBytes(8).toString('hex')}.log`);
}

/** 清理超过 1 小时的旧 bash 临时日志（非阻塞） */
function cleanupOldBashLogs(): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(tmpdir())) {
      if (!f.startsWith(BASH_TEMP_PREFIX)) continue;
      try {
        const s = fs.statSync(path.join(tmpdir(), f));
        if (now - s.birthtimeMs > 3_600_000) fs.unlinkSync(path.join(tmpdir(), f));
      } catch { /* 跳过无法 stat 的文件 */ }
    }
  } catch { /* 非关键路径 */ }
}

/**
 * 执行命令工具（支持 timeout / background / stdin）。
 *   - command：要执行的 shell 命令
 *   - cwd：工作目录（相对工作区根，默认工作区根；仅限工作区内）
 *   - timeout：超时毫秒（默认 tool.bash.defaultTimeout=30000，上限 maxTimeout=120000）
 *   - background：后台执行（detached spawn + 日志写临时文件 + 立即返回 PID，适合长驻服务）
 *   - stdin：传给命令的标准输入（可选）
 */
export function makeBashTool(config: AgentConfig): Tool {
  const ns = getNamespaceConfig(config, NS_TOOL_BASH);
  const defaultTimeout = typeof ns.defaultTimeout === 'number' ? ns.defaultTimeout : 30_000;
  const maxTimeout = typeof ns.maxTimeout === 'number' ? ns.maxTimeout : 120_000;
  return defineTool({
    name: 'bash', label: '执行命令', ns: NS_TOOL_BASH, requires: [CAPABILITY_BASE],
    description: '在工作区内执行 shell 命令并返回输出（Windows 底层：PowerShell 7 → PowerShell → cmd）。支持 timeout（默认 30s，上限 120s）、background（后台执行不阻塞，返回 PID + 日志文件）、stdin（管道输入）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（相对工作区根 workspace/default 解析，默认工作区根；仅限工作区内，越界会被拒绝）' },
        timeout: { type: 'number', description: `超时毫秒，默认 ${defaultTimeout}，上限 ${maxTimeout}。超长时间任务建议配合 background 使用。` },
        background: { type: 'boolean', description: '后台执行：detached spawn + 日志写临时文件，立即返回 PID 不阻塞。适合启动长驻服务（后端、定时任务等）。可用 Stop-Process -Id <pid> 停止，日志路径返回后可用 read 查看。' },
        stdin: { type: 'string', description: '传给命令的标准输入（可选）。用于 sudo、passwd 等需要输入的命令。' },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd, timeout, background, stdin }, stream, signal) => {
      let dir: string;
      if (cwd) {
        try {
          dir = resolveSafePath(config, cwd);
        } catch (e) {
          return JSON.stringify({
            status: 'error',
            data: {
              message: `${(e as Error).message}。cwd 仅限工作区内（相对 workspace/default 解析）`,
            },
          });
        }
      } else {
        dir = workspaceRoot();
      }
      if (!fs.existsSync(dir)) {
        return JSON.stringify({
          status: 'error',
          data: {
            message: `工作目录不存在：${dir}（cwd 相对工作区根 workspace/default 解析，默认工作区根）`,
          },
        });
      }
      // 命令级沙箱：拦截允许范围外访问（cd .. 越界 / 盘符 / 绝对路径 / ../ 引用）；
      // 与路径白名单对齐：目标解析后落在 workspaceRoot 或 security.allowedPaths 内放行
      const allowedRoots = [workspaceRoot(), ...(getAllowedPaths(config) ?? [])
        .map(a => (path.isAbsolute(a) ? a : path.resolve(workspaceRoot(), a)))];
      const violation = bashCommandViolation(command ?? '', allowedRoots);
      if (violation) {
        return JSON.stringify({
          status: 'error',
          data: { command, cwd: dir, message: `${violation}` },
        });
      }
      const { shell, args: shellArgs } = getShellConfig();
      // Windows (pwsh/5.1)：强制 UTF-8 输出编码（cmd 不支持该语法，跳过）
      let actualCommand = command;
      if (process.platform === 'win32' && shell !== 'cmd') {
        actualCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
      }

      // ---- 后台执行：detached spawn + 日志文件，立即返回 PID ----
      if (background === true) {
        try {
          const logFile = bashTempLogPath();
          const fd = fs.openSync(logFile, 'a');
          const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], {
            cwd: dir,
            // Windows：detached:false + unref 即可让子进程存活；Unix：detached:true 创建独立进程组
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', fd, fd],
            shell: false,
          });
          child.unref();
          return JSON.stringify({
            status: 'success',
            data: {
              command,
              cwd: dir,
              background: true,
              pid: child.pid,
              log_file: logFile,
              message: `已在后台启动 (PID ${child.pid})。日志：${logFile}。可查看日志或用 Stop-Process -Id ${child.pid} 停止。`,
            },
          });
        } catch (err: any) {
          return JSON.stringify({
            status: 'error',
            data: { command, cwd: dir, message: `后台启动失败: ${err?.message ?? String(err)}` },
          });
        }
      }

      // ---- 前台执行（流式输出 + 超时 + stdin）----
      cleanupOldBashLogs();
      return new Promise<string>((resolve) => {
        let output = '';
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        // timeout 可调，clamp 到 maxTimeout
        const effectiveTimeout = typeof timeout === 'number' && timeout > 0
          ? Math.min(timeout, maxTimeout)
          : defaultTimeout;

        const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], {
          cwd: dir,
          windowsHide: true,
          stdio: stdin != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        const onData = (data: Buffer) => {
          const chunk = data.toString('utf-8');
          output += chunk;
          stream?.onChunk(chunk);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        if (stdin != null && child.stdin) {
          child.stdin.write(stdin);
          child.stdin.end();
        }

        if (effectiveTimeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, effectiveTimeout);
        }
        const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (timedOut) {
            resolve(JSON.stringify({ status: 'timeout', data: { command, cwd: dir, message: `命令超时（${effectiveTimeout}ms）。建议增大 timeout 参数或改用 background 后台执行。`, timed_out: true } }));
          } else {
            // 结构化结果：与 read/write/edit 等工具一致（前端 ToolResultTerminal 依赖
            // status+data{command,cwd,output,exit_code} 渲染终端卡片；纯文本会让
            // 工具卡退化为普通文本，且流式中无法实时升级为专用卡片）。
            const exitCode = typeof code === 'number' ? code : null;
            const success = exitCode === 0;
            const totalBytes = Buffer.byteLength(output, 'utf-8');
            resolve(JSON.stringify({
              status: success ? 'success' : 'error',
              data: {
                command,
                cwd: dir,
                output: output || '(无输出)',
                exit_code: exitCode,
                success,
                truncated: false,
                total_bytes: totalBytes,
                timed_out: false,
              },
            }));
          }
        });
        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(JSON.stringify({ status: 'error', data: { command, cwd: dir, message: err?.message ?? String(err) } }));
        });
      });
    },
    extractLabel: (args) => args.command,
  });
}

/** 文件类工具工厂（per-Agent 烘焙沙箱） */

/** shell 工具族（bash） */
export function makeShellTools(config: AgentConfig): Tool[] {
  return [makeBashTool(config)];
}
