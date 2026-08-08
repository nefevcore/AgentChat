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
import { defineTool } from '../../define-tool';
import { getNamespaceConfig } from '@agents/config';
import { NS_TOOL_BASH } from '../namespaces';
import type { AgentConfig } from '@agents/config';
import type { Tool } from '@core/types';
import { resolveSafePath, workspaceRoot } from './shared';

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

/** 读取文件工具 */
export function makeReadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'read', label: '读取文件', requires: ['agent'],
    description: '读取文本文件内容（受工作区沙箱限制）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件相对路径（相对工作区）' } },
      required: ['path'],
    },
    execute: async ({ path: p }) => {
      const file = resolveSafePath(config, p);
      if (!fs.existsSync(file)) {
        return JSON.stringify({ status: 'error', data: { message: `文件不存在：${p}` } });
      }
      return fs.readFileSync(file, 'utf-8');
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

/** 编辑文件工具（查找替换） */
export function makeEditTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'edit', label: '编辑文件', requires: ['agent'],
    description: '在文件内查找并替换文本（old_string 需在文件中唯一可辨）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        old_string: { type: 'string', description: '要替换的原文' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    execute: async ({ path: p, old_string, new_string }) => {
      const file = resolveSafePath(config, p);
      if (!fs.existsSync(file)) {
        return JSON.stringify({ status: 'error', data: { message: `文件不存在：${p}` } });
      }
      const content = fs.readFileSync(file, 'utf-8');
      if (!content.includes(old_string)) {
        return JSON.stringify({ status: 'error', data: { message: '未找到匹配的 old_string' } });
      }
      const count = content.split(old_string).length - 1;
      fs.writeFileSync(file, content.replace(old_string, new_string), 'utf-8');
      return JSON.stringify({ status: 'ok', data: { message: `已替换 ${count} 处` } });
    },
    extractLabel: (args) => args.path,
  });
}

/** 执行命令工具 */
export function makeBashTool(config: AgentConfig): Tool {
  const ns = getNamespaceConfig(config, NS_TOOL_BASH);
  const defaultTimeout = typeof ns.defaultTimeout === 'number' ? ns.defaultTimeout : 30_000;
  return defineTool({
    name: 'bash', label: '执行命令', ns: NS_TOOL_BASH, requires: ['agent'],
    description: '在工作区内执行 shell 命令并返回输出（Windows 底层：PowerShell 7 → PowerShell → cmd）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（相对工作区，默认工作区根）' },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd }, stream, signal) => {
      const dir = cwd ? resolveSafePath(config, cwd) : workspaceRoot();
      if (!fs.existsSync(dir)) {
        return JSON.stringify({ status: 'error', data: { message: `工作目录不存在：${dir}` } });
      }
      const { shell, args: shellArgs } = getShellConfig();
      // Windows (pwsh/5.1)：强制 UTF-8 输出编码（cmd 不支持该语法，跳过）
      let actualCommand = command;
      if (process.platform === 'win32' && shell !== 'cmd') {
        actualCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
      }

      return new Promise<string>((resolve) => {
        let output = '';
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], {
          cwd: dir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        const onData = (data: Buffer) => {
          const chunk = data.toString('utf-8');
          output += chunk;
          stream?.onChunk(chunk);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        if (defaultTimeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, defaultTimeout);
        }
        const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (timedOut) {
            resolve(JSON.stringify({ status: 'timeout', data: { message: `命令超时（${defaultTimeout}ms）` } }));
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
