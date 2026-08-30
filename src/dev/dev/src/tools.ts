// ============================================================
// @agentchat/dev —— 开发辅助工具（read_logs/reload/reload_modules）
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { defineTool } from '@agentchat/toolkit';
import { ToolInterrupt } from '@agentchat/agent-loop';
import { readLogs, clearLogBuffer, createLogger, isSupervised } from '@agentchat/util';
const PROCESS_START_TS = Date.now();
import { CAPABILITY_DEV, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import { makeReloadModulesTool, type ModuleReloadHmr } from './module-reload';

/** read_logs 工具（照搬旧，经 src/core/logger 环形缓冲） */
export function makeReadLogsTool(_config: AgentConfig): Tool {
  return defineTool({
    name: 'read_logs', label: '读取日志', requires: [CAPABILITY_DEV],
    description: '查看后端运行日志（最近 2000 条）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数（默认 100，最大 500）', minimum: 1, maximum: 500 },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: '最低日志级别' },
        keyword: { type: 'string', description: '关键词过滤' },
        clear: { type: 'boolean', description: '先清空缓冲再收集（默认 false）' },
      },
    },
    extractLabel: (args) => {
      const parts: string[] = [];
      if (args.level) parts.push(args.level);
      if (args.keyword) parts.push(`"${args.keyword}"`);
      if (args.limit) parts.push(`${args.limit}条`);
      return `日志${parts.length ? ' ' + parts.join(' ') : ''}`;
    },
    execute: async (args) => {
      try {
        if (args.clear === true) {
          clearLogBuffer();
        }
        const entries = readLogs({
          level: args.level as any,
          keyword: args.keyword as string | undefined,
          limit: args.limit as number | undefined,
        });
        if (entries.length === 0) {
          return JSON.stringify({ status: 'ok', data: { message: '日志缓冲为空' } });
        }
        return JSON.stringify({
          status: 'ok',
          data: {
            count: entries.length,
            logs: entries.map(e => e.line),
          },
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}

// ============================================================
// web_search —— 实时网络搜索
// ============================================================


export function findChangedPluginSources(rootDir: string = process.cwd(), since: number = PROCESS_START_TS): string[] {
  // 扫描整个 src/ 下的后端 TypeScript 源码，而不只是 src/plugins：
  // 本项目工具/插件分散在 src/*/*/src（如 src/shell/shell/src/tools.ts），
  // reload 只重载配置、不清 tsx ESM 模块缓存，改这些文件需 reload_modules。
  // since 缺省 = 进程启动；HMR 可用时传水位线（上次成功模块重载时刻）。
  const srcRoot = path.resolve(rootDir, 'src');
  const changed: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 跳过前端、依赖、构建产物与测试目录（测试改动不要求重启后端）
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'coverage' || e.name === '.git'
          || e.name === 'tests' || e.name === 'test' || e.name === '__tests__') continue;
        if (depth === 0 && e.name === 'ui') continue;
        walk(full, depth + 1);
      } else if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name)) {
        try {
          if (fs.statSync(full).mtimeMs > since) {
            changed.push(path.relative(rootDir, full));
          }
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(srcRoot, 0);
  return changed;
}

/** reload 工具：统一热加载（照搬旧：语义化中断） */
export function makeReloadTool(config: AgentConfig, getHmr?: () => ModuleReloadHmr | undefined): Tool {
  return defineTool({
    name: 'reload', label: '热加载', requires: [CAPABILITY_DEV],
    description: '重新加载配置（改了 Agent 配置文件后调用）。改了源码请用 reload_modules。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['self', 'global', 'all'], description: '范围：self 本 Agent / global 全部 / all 两者（默认）' },
      },
    },
    extractLabel: (args) => `⟳ ${args.scope || 'all'}`,
    execute: async (args, stream) => {
      const scope = (args.scope || 'all') as 'self' | 'global' | 'all';
      // 检测后端源码变更：reload 只重载配置，无法加载代码改动。
      // 明确提示而非静默不生效（Agent 改完 src/ 下工具/插件源码后调 reload 会看到此警告）。
      // 水位线感知：reload_modules 成功后水位线推进，已重载的改动不再告警。
      if (scope === 'global' || scope === 'all') {
        const hmr = getHmr?.();
        const changed = findChangedPluginSources(process.cwd(), hmr?.watermark ?? PROCESS_START_TS);
        if (changed.length > 0) {
          const shown = changed.slice(0, 3).map(f => path.basename(f));
          stream?.onChunk?.(
            `⚠️ 检测到 ${changed.length} 个插件源码文件有未重载的改动（${shown.join('、')}${changed.length > 3 ? '…' : ''}）：` +
            `reload 只重载配置、无法加载代码改动，请改用 reload_modules 热重载模块（框架文件除外，那类用 system_restart）。本次仍会重载配置。\n`
          );
        }
      }
      // 语义化中断：由 loop 收尾后经 interruptHandlers 执行热重载（L5 装配）
      throw new ToolInterrupt({ type: 'reload-requested', scope });
    },
  });
}

/** 开发辅助工具族（read_logs + reload + reload_modules） */
export function makeDevTools(
  config: AgentConfig,
  getHmr?: () => ModuleReloadHmr | undefined,
): Tool[] {
  return [
    makeReadLogsTool(config),
    makeReloadTool(config, getHmr),
    makeReloadModulesTool(() => getHmr?.(), config),
  ];
}
