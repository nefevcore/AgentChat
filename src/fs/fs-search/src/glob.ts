// ============================================================
// @agentchat/fs-search/src/glob.ts —— glob 工具（按路径模式找文件）
//
// 参考 DSH dsh-tool-fs-search 的 glob：
//   · 模式不含 "/" → 匹配任意深度的文件名（`*.ts` 匹配整棵树）
//   · 模式含 "/" → 锚定相对搜索根的路径（支持 ** 跨层级）
//   · 只返回文件（不返回目录）；包含隐藏文件
//   · 按修改时间从新到旧排序；内联上限 100 条（超出保留最新部分并提示）
// （DSH 由打包 ripgrep 驱动；此处为纯 TS 原生遍历，跳过 VCS 元数据与
//   node_modules/__pycache__，敏感黑名单文件与 read/write 同口径排除）
// ============================================================
import * as fs from 'fs';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import { defineTool, resolveSafePath } from '@agentchat/toolkit';
import { globToRegExp, normalizeGlobPattern } from './glob-regex';
import { walkFiles } from './walk';
import type { Tool } from '@agentchat/agent-loop';

/** 内联展示上限（与 DSH globMaxResults / Claude Code GlobTool 相同） */
export const GLOB_MAX_RESULTS = 100;

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ status: 'ok', data });
}
function fail(message: string): string {
  return JSON.stringify({ status: 'error', data: { message } });
}

/** glob 工具（per-Agent 烘焙 config：沙箱根与黑名单） */
export function makeGlobTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'glob', label: '文件匹配', requires: [CAPABILITY_BASE],
    description:
      '按路径模式查找文件（不要用 shell find）。模式不含 "/" 时匹配任意深度的文件名（如 "*.ts" 匹配整棵树而非仅顶层）；含 "/" 时锚定相对搜索根的路径。支持 ** 跨目录层级、* 单段通配、? 单字符、{a,b} 交替与 [...] 字符类。只返回文件（不含目录），包含隐藏文件；跳过 .git/node_modules 等目录与敏感黑名单文件。结果按修改时间从新到旧排序，最多展示 100 条（超出保留最新部分并给出省略提示）。找到文件后用 read 读取内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"、"*.test.ts"、"src/*/index.ts"' },
        path: { type: 'string', description: '目录搜索根（相对工作区；缺省为工作区根）' },
      },
      required: ['pattern'],
    },
    extractLabel: (args) => String(args.pattern ?? ''),
    execute: async ({ pattern: rawPattern, path: rawPath }) => {
      try {
        const pattern = String(rawPattern ?? '').trim();
        if (!pattern) return fail('缺少 pattern 参数（不能为空）');

        const rootInput = String(rawPath ?? '.');
        const rootAbs = resolveSafePath(config, rootInput);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(rootAbs);
        } catch {
          return fail(`路径不存在: ${rootInput}`);
        }
        if (!stat.isDirectory()) return fail(`path 必须是目录（glob 只按模式发现文件）: ${rootInput}`);

        const normalized = normalizeGlobPattern(pattern);
        if (!normalized) return fail('pattern 不能为空');
        const matchBase = !normalized.includes('/');
        let re: RegExp;
        try {
          re = globToRegExp(normalized);
        } catch (err: any) {
          return fail(`无效的 glob 模式 "${pattern}": ${err?.message ?? String(err)}`);
        }

        const { entries, capped } = walkFiles(config, rootAbs);
        const matched = entries.filter((e) =>
          re.test(matchBase ? e.rel.slice(e.rel.lastIndexOf('/') + 1) : e.rel));
        // 修改时间从新到旧；同 mtime 按路径稳定排序
        matched.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

        const shown = matched.slice(0, GLOB_MAX_RESULTS);
        const notes: string[] = [];
        if (matched.length === 0) notes.push('No files found（未找到匹配文件，可放宽模式或换搜索根）');
        else if (matched.length > shown.length) notes.push(`共 ${matched.length} 条匹配，仅展示最新的 ${shown.length} 条（按修改时间）`);
        if (capped) notes.push(`扫描在 ${entries.length} 个文件处截断（病态大目录？可用 path 收窄搜索根）`);

        return ok({
          root: rootInput,
          total: matched.length,
          shown: shown.length,
          paths: shown.map((e) => e.rel),
          ...(notes.length ? { note: notes.join('；') } : {}),
        });
      } catch (err: any) {
        return fail(err?.message ?? String(err));
      }
    },
  });
}
