// ============================================================
// @agentchat/dev —— 开发辅助工具（code_search/read_logs/reload）
// 领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { defineTool, workspaceRoot } from '@agentchat/toolkit';
import { ToolInterrupt } from '@agentchat/agent-loop';
import { readLogs, clearLogBuffer, createLogger, isSupervised } from '@agentchat/util';
const PROCESS_START_TS = Date.now();
import { CAPABILITY_DEV, type AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'release', '.cache',
  'workspace', 'sessions', 'archive', '_tmp',
]);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.isFile()) {
      out.push(path.join(dir, ent.name));
    }
  }
}

/** code_search 工具（照搬旧） */
export function makeCodeSearchTool(_config: AgentConfig): Tool {
  return defineTool({
    name: 'code_search', label: '代码搜索', requires: [CAPABILITY_DEV],
    description: '用正则表达式搜索项目源码，返回 file:line:匹配行 结果。用于可靠地查找代码，替代 bash grep/Select-String。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式，如 "chat.send|handleChatSend"' },
        dirs: { type: 'array', items: { type: 'string' }, description: '搜索目录（默认 ["src","scripts"]）' },
        include: { type: 'array', items: { type: 'string' }, description: '仅匹配这些后缀文件，如 [".ts",".vue"]（默认全部）' },
        context: { type: 'number', description: '匹配行上下文行数（默认 0）' },
        maxResults: { type: 'number', description: '结果上限（默认 40）' },
        case_sensitive: { type: 'boolean', description: '大小写敏感（默认 false）' },
        count: { type: 'boolean', description: '仅统计每个文件的匹配行数，不返回匹配内容' },
      },
      required: ['pattern'],
    },
    extractLabel: (args) => `搜索 ${String(args.pattern || '').slice(0, 30)}`,
    execute: async (args) => {
      try {
        const pattern = String(args.pattern ?? '');
        if (!pattern) {
          return JSON.stringify({ status: 'error', data: { message: '缺少 pattern 参数' } });
        }

        let regex: RegExp;
        try {
          regex = new RegExp(pattern, args.case_sensitive ? '' : 'i');
        } catch (err: any) {
          return JSON.stringify({ status: 'error', data: { message: `正则无效: ${err.message}` } });
        }

        // 项目根 = workspaceRoot 的上两级（workspace/default → workspace → 项目根）
        const wsRoot = workspaceRoot();
        const projectRoot = path.dirname(path.dirname(wsRoot));

        const dirs = Array.isArray(args.dirs) && args.dirs.length
          ? args.dirs.map((d: string) => d)
          : ['src', 'scripts'];
        const include = Array.isArray(args.include) && args.include.length
          ? args.include.map((s: string) => (s.startsWith('.') ? s : `.${s}`))
          : null;
        const context = Math.max(0, Number(args.context) || 0);
        const maxResults = Math.min(200, Number(args.maxResults) || 40);

        const files: string[] = [];
        for (const d of dirs) {
          const full = path.isAbsolute(d) ? d : path.join(projectRoot, d);
          if (fs.existsSync(full)) walk(full, files);
        }

        const results: Array<{ path: string; line: number; content: string; ctx: string[] }> = [];
        const countMode = args.count === true;
        const counts = new Map<string, number>();
        for (const file of files) {
          if (include && !include.some(ext => file.endsWith(ext))) continue;
          let lines: string[];
          try {
            lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
          } catch {
            continue;
          }
          let fileMatches = 0;
          for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue;
            regex.lastIndex = 0;
            fileMatches++;
            if (!countMode) {
              const ctx = [];
              for (let c = 1; c <= context; c++) {
                if (i - c >= 0) ctx.push(lines[i - c]);
                if (i + c < lines.length) ctx.push(lines[i + c]);
              }
              results.push({
                path: path.relative(projectRoot, file).split(path.sep).join('/'),
                line: i + 1,
                content: lines[i].trim(),
                ctx,
              });
            }
          }
          if (countMode && fileMatches > 0) counts.set(file, fileMatches);
        }

        if (countMode) {
          return JSON.stringify({ status: 'ok', data: { count: counts.size, files: Array.from(counts.entries()) } });
        }
        if (results.length === 0) {
          return JSON.stringify({ status: 'ok', data: { message: '未找到匹配', total: 0 } });
        }
        const limited = results.slice(0, maxResults);
        const lines = limited.map(r =>
          `${r.path}:${r.line}: ${r.content}` + (r.ctx.length ? `\n  ctx: ${r.ctx.join(' | ').slice(0, 200)}` : '')
        );
        return JSON.stringify({
          status: 'ok',
          data: {
            total: results.length,
            shown: limited.length,
            message: results.length > maxResults ? `（仅显示前 ${maxResults} 条）` : '',
          },
          lines,
        });
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
      }
    },
  });
}


/** read_logs 工具（照搬旧，经 src/core/logger 环形缓冲） */
export function makeReadLogsTool(_config: AgentConfig): Tool {
  return defineTool({
    name: 'read_logs', label: '读取日志', requires: [CAPABILITY_DEV],
    description: '从内存环形缓冲读取后端日志（最近 2000 条）。用于调试：按 level（debug/info/warn/error）、keyword、limit 过滤。设置 clear=true 可先清空缓冲再收集新日志。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数（默认 100，最大 500）' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: '最低级别过滤' },
        keyword: { type: 'string', description: '关键词过滤（匹配完整日志行）' },
        clear: { type: 'boolean', description: '先清空缓冲再返回（默认 false）' },
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


export function findChangedPluginSources(rootDir: string = process.cwd()): string[] {
  // 扫描整个 src/ 下的后端 TypeScript 源码，而不只是 src/plugins：
  // 本项目工具/插件分散在 src/*/*/src（如 src/shell/shell/src/tools.ts），
  // reload 只重载配置、不清 tsx ESM 模块缓存，改这些文件同样必须 system_restart。
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
          if (fs.statSync(full).mtimeMs > PROCESS_START_TS) {
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
export function makeReloadTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'reload', label: '热加载', requires: [CAPABILITY_DEV],
    description: '热重载配置。scope=self 重读本 Agent 配置并重新注册（config.json/工具开关改动立即生效）；scope=global 重读全部 Agent 配置；scope=all 两者都做（默认）。注意：仅重载配置，不重载插件源码——修改 src/ 下任意后端 TypeScript 源码（含 src/*/*/src 工具实现）后必须用 system_restart 进程级重启才生效（检测到源码变更会提示）。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['self', 'global', 'all'], description: '重载范围（默认 all；仅配置生效，不重载插件源码）' },
      },
    },
    extractLabel: (args) => `⟳ ${args.scope || 'all'}`,
    execute: async (args, stream) => {
      const scope = (args.scope || 'all') as 'self' | 'global' | 'all';
      // 检测后端源码变更：reload 只重载配置，无法加载代码改动。
      // 明确提示而非静默不生效（Agent 改完 src/ 下工具/插件源码后调 reload 会看到此警告）。
      if (scope === 'global' || scope === 'all') {
        const changed = findChangedPluginSources();
        if (changed.length > 0) {
          const shown = changed.slice(0, 3).map(f => path.basename(f));
          stream?.onChunk?.(
            `⚠️ 检测到 ${changed.length} 个插件源码文件在进程启动后有改动（${shown.join('、')}${changed.length > 3 ? '…' : ''}）：` +
            `reload 只重载配置、无法加载代码改动，请改用 system_restart 重启后端后生效。本次仍会重载配置。\n`
          );
        }
      }
      // 语义化中断：由 loop 收尾后经 interruptHandlers 执行热重载（L5 装配）
      throw new ToolInterrupt({ type: 'reload-requested', scope });
    },
  });
}

/** ask_questions 工具：向用户批量提问等待决策（经 ToolContext.interaction） */

/** 开发辅助工具族（code_search + read_logs + reload） */
export function makeDevTools(config: AgentConfig): Tool[] {
  return [makeCodeSearchTool(config), makeReadLogsTool(config), makeReloadTool(config)];
}
