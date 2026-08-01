// ============================================================
// code_search 工具 —— 递归搜索项目代码
//
// 用途：
//   在当前项目（src/webui/scripts）中按正则搜索代码，
//   返回 路径:行号:匹配行。Windows 环境没有 rg/grep，
//   Select-String 不稳定，此工具提供可靠的代码定位。
//
// 参数：
//   pattern    – 正则表达式（必填）
//   dirs       – 搜索目录数组（默认 ["src", "webui", "scripts"]）
//   include    – 仅匹配这些后缀的文件（如 [".ts",".vue"]，默认全部）
//   context    – 匹配行上下文行数（默认 0）
//   maxResults – 结果上限（默认 40，防止刷屏）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getGlobalConfig } from '@core/config';
import * as fs from 'fs';
import * as path from 'path';

// 跳过的目录（构建产物/依赖/运行时数据）
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

export const tool: Tool = {
  ...meta,
  definition: {
    type: 'function',
    function: {
      name: 'code_search',
      description: 'Search project source code with a regex pattern. Returns file:line:matched-line results. Use this instead of bash grep/Select-String for reliable code lookup.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式，如 "chat.send|handleChatSend"' },
          dirs: {
            type: 'array', items: { type: 'string' },
            description: '搜索目录（默认 ["src","webui","scripts"]）',
          },
          include: {
            type: 'array', items: { type: 'string' },
            description: '仅匹配这些后缀文件，如 [".ts",".vue"]（默认全部）',
          },
          context: { type: 'number', description: '匹配行上下文行数（默认 0）' },
          maxResults: { type: 'number', description: '结果上限（默认 40）' },
        },
        required: ['pattern'],
      },
    },
  },

  execute: async (args) => {
    try {
      const pattern = String(args.pattern ?? '');
      if (!pattern) {
        return JSON.stringify({ status: 'error', data: { message: '缺少 pattern 参数' } });
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch (err: any) {
        return JSON.stringify({ status: 'error', data: { message: `正则无效: ${err.message}` } });
      }

      // 项目根 = workspaceDir 的上两级（workspace/default → workspace → 项目根）
      const workspaceDir = getGlobalConfig().workspaceDir;
      const projectRoot = path.dirname(path.dirname(workspaceDir));

      const dirs = Array.isArray(args.dirs) && args.dirs.length
        ? args.dirs.map((d: string) => d)
        : ['src', 'webui', 'scripts'];
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
      for (const file of files) {
        if (include && !include.some(ext => file.endsWith(ext))) continue;
        let lines: string[];
        try {
          lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
        } catch {
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const ctxLines: string[] = [];
            for (let c = Math.max(0, i - context); c <= Math.min(lines.length - 1, i + context); c++) {
              if (c !== i) ctxLines.push(`${c + 1}: ${lines[c]}`);
            }
            results.push({ path: file, line: i + 1, content: lines[i].trim(), ctx: ctxLines });
            if (results.length >= maxResults) break;
          }
        }
        if (results.length >= maxResults) break;
      }

      return JSON.stringify({
        status: 'ok',
        data: {
          pattern,
          total: results.length,
          truncated: results.length >= maxResults,
          results,
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err.message } });
    }
  },
};
