// ============================================================
// src/plugins/builtin/tools/files.ts —— 文件工具（read/write/edit/bash）
//
// 迁移自旧 mod 的 tools/{read,write,edit,bash}，按领域聚合为一个文件。
// 工厂 per-Agent 烘焙：security.allowedPaths 沙箱 + tool.* 命名空间配置。
//
// 注意：bash 命令审核由旧 agent_profile 拦截器承担（写/编辑 agents 配置目录
// 的危险操作拦截）——新架构转 toolExecutionStartHook（hooks/ 层补）。
//
// 依赖方向：仅依赖本层 shared + @agents/config + @core/types + define-tool。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { defineTool } from '../../define-tool';
import { getNamespaceConfig } from '@agents/config';
import { NS_TOOL_BASH } from '../namespaces';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';
import { resolveSafePath, workspaceRoot, computeFileHash, formatHashlineHeader, formatNumberedLine } from './shared';
import { makeEditTool } from './edit/tool';
import { recordSnapshot } from './edit/hashline-snapshot';

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
export function makeReadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'read', label: '读取文件', requires: ['agent'],
    description: '读取文件内容或列出目录。默认启用 Hashline v2 格式（[PATH#TAG] 头 + 行号:内容），配合 edit 的 SWAP/INS 操作精确定位。',
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
    description: '写入/覆盖文本文件（自动创建父目录，受沙箱限制）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path: p, content }) => {
      const file = resolveSafePath(config, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf-8');
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
    name: 'bash', label: '执行命令', ns: NS_TOOL_BASH, requires: ['agent'],
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

        child.on('close', () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (timedOut) {
            resolve(JSON.stringify({ status: 'timeout', data: { message: `命令超时（${effectiveTimeout}ms）。建议增大 timeout 参数或改用 background 后台执行。` } }));
          } else {
            resolve(output || '(无输出)');
          }
        });
        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } }));
        });
      });
    },
    extractLabel: (args) => args.command,
  });
}

/** 文件类工具工厂（per-Agent 烘焙沙箱） */
export function makeFileTools(config: AgentConfig): Tool[] {
  return [
    makeReadTool(config),
    makeWriteTool(config),
    makeEditTool(config),
    makeBashTool(config),
  ];
}
