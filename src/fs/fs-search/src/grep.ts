// ============================================================
// @agentchat/fs-search/src/grep.ts —— grep 工具（按内容找文件）
//
// 参考 DSH dsh-tool-fs-search 的 grep：
//   · pattern 为正则表达式；path 可为文件或目录；include 为单个正向
//     glob 过滤器（支持 {a,b} 交替；拒绝逗号列表与否定值）
//   · 结果按文件分组，`Line N: <preview>`；内联上限 250 条匹配、
//     每行预览 2000 字符（截断带标记）
//   · 二进制文件（含 NUL 字节）跳过；空搜索返回 No matches found
//   · 刻意不暴露 head_limit/offset/大小写开关（schema 保持简单；
//     需要上下文用 read 读匹配文件）
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { CAPABILITY_BASE, type AgentConfig } from '@agentchat/agent-config';
import { defineTool, resolveSafePath, sandboxWorkdir } from '@agentchat/toolkit';
import { globToRegExp, normalizeGlobPattern } from './glob-regex';
import { toPosix, walkFiles, type WalkEntry } from './walk';
import type { Tool } from '@agentchat/agent-loop';

/** 内联匹配上限（与 DSH grepMaxMatches / Claude Code GrepTool head_limit 相同） */
export const GREP_MAX_MATCHES = 250;
/** 匹配收集硬顶（超出即停止扫描并标记 truncated，防病态大仓库） */
export const GREP_HARD_CAP = 2000;
/** 每行预览字符上限（与 DSH grepMaxLineBytes 同值） */
export const GREP_MAX_LINE_CHARS = 2000;
/** 二进制探测窗口（前 8KB 含 NUL 即视为二进制跳过） */
const BINARY_SNIFF_BYTES = 8192;

interface LineMatch {
  line: number;
  preview: string;
}
interface FileGroup {
  path: string;
  matches: LineMatch[];
}

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ status: 'ok', data });
}
function fail(message: string): string {
  return JSON.stringify({ status: 'error', data: { message } });
}

/** 校验 include 参数：单个正向 glob（拒绝顶层逗号列表与 ! 否定，与 DSH 口径一致；花括号交替内逗号允许） */
function compileInclude(include: string): RegExp {
  if (include.startsWith('!')) {
    throw new Error('include 不支持否定值（!…）；请提供正向 glob，如 "*.ts" 或 "*.{ts,tsx}"');
  }
  // 仅拒绝花括号外的顶层逗号（"*.{ts,tsx}" 合法；"*.ts,*.tsx" 列表不合法）
  let depth = 0;
  for (const ch of include) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      throw new Error('include 不支持逗号列表；多后缀请用花括号交替，如 "*.{ts,tsx}"');
    }
  }
  return globToRegExp(normalizeGlobPattern(include));
}

function previewOf(line: string): string {
  return line.length > GREP_MAX_LINE_CHARS
    ? line.slice(0, GREP_MAX_LINE_CHARS) + '…(line truncated)'
    : line;
}

/** 在单文件中收集匹配（返回新增匹配数；binary=true 表示跳过） */
function searchFile(abs: string, regex: RegExp, sink: LineMatch[]): number {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return 0;
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0; // 二进制：跳过
  const lines = buf.toString('utf-8').split('\n');
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    sink.push({ line: i + 1, preview: previewOf(lines[i]) });
    added++;
  }
  return added;
}

/** grep 工具（per-Agent 烘焙 config：沙箱根与黑名单） */
export function makeGrepTool(config: AgentConfig): Tool {
  return defineTool({
    name: 'grep', label: '内容搜索', requires: [CAPABILITY_BASE],
    description: '按正则表达式搜索文件内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JS RegExp 语法）' },
        path: { type: 'string', description: '搜索的文件或目录（默认工作区根）' },
        include: { type: 'string', description: '文件名过滤 glob，如 "*.ts"' },
      },
      required: ['pattern'],
    },
    extractLabel: (args) => String(args.pattern ?? '').slice(0, 30),
    execute: async ({ pattern: rawPattern, path: rawPath, include: rawInclude }) => {
      try {
        const pattern = String(rawPattern ?? '');
        if (!pattern.trim()) return fail('缺少 pattern 参数（不能为空）');

        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch (err: any) {
          return fail(`无效的正则表达式 "${pattern}": ${err?.message ?? String(err)}`);
        }

        let includeRe: RegExp | undefined;
        if (rawInclude !== undefined) {
          if (typeof rawInclude !== 'string' || !rawInclude.trim()) return fail('include 必须是非空 glob 字符串');
          try {
            includeRe = compileInclude(rawInclude.trim());
          } catch (err: any) {
            return fail(err?.message ?? String(err));
          }
        }

        const targetInput = String(rawPath ?? '.');
        const targetAbs = resolveSafePath(config, targetInput);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(targetAbs);
        } catch {
          return fail(`路径不存在: ${targetInput}`);
        }

        // 目标文件集合：单文件直搜（include 不适用）；目录走有界遍历 + include 过滤
        let targets: WalkEntry[];
        let capped = false;
        if (stat.isFile()) {
          const base = sandboxWorkdir(config);
          let rel = toPosix(path.relative(base, targetAbs));
          if (rel.startsWith('..') || path.isAbsolute(rel)) rel = targetAbs; // 基准外：回退绝对路径
          targets = [{ abs: targetAbs, rel, mtimeMs: 0 }];
        } else if (stat.isDirectory()) {
          const walked = walkFiles(config, targetAbs);
          targets = includeRe
            ? walked.entries.filter((e) => includeRe!.test(e.rel.slice(e.rel.lastIndexOf('/') + 1)))
            : walked.entries;
          capped = walked.capped;
        } else {
          return fail(`path 既不是文件也不是目录: ${targetInput}`);
        }

        const groups: FileGroup[] = [];
        let total = 0;
        let truncated = false;
        for (const entry of targets) {
          if (total >= GREP_HARD_CAP) {
            truncated = true;
            break;
          }
          const sink: LineMatch[] = [];
          searchFile(entry.abs, regex, sink);
          if (sink.length === 0) continue;
          total += sink.length;
          groups.push({ path: entry.rel, matches: sink });
        }
        if (total >= GREP_HARD_CAP) truncated = true;

        const notes: string[] = [];
        if (groups.length === 0) {
          notes.push('No matches found（未找到匹配，可调整 pattern / path / include）');
        } else if (total > GREP_MAX_MATCHES) {
          notes.push(`共 ${total} 条匹配，仅内联展示前 ${GREP_MAX_MATCHES} 条（其余已省略；请收窄 path 或 pattern）`);
        }
        if (truncated) notes.push(`匹配达到扫描硬顶 ${GREP_HARD_CAP}，结果可能不完整（请收窄搜索范围）`);
        if (capped) notes.push(`扫描在 ${targets.length} 个文件处截断（病态大目录？可用 path 收窄搜索根）`);

        // 内联页面：按文件顺序截取前 GREP_MAX_MATCHES 条
        let budget = GREP_MAX_MATCHES;
        const shownGroups: FileGroup[] = [];
        for (const g of groups) {
          if (budget <= 0) break;
          shownGroups.push({ path: g.path, matches: g.matches.slice(0, budget) });
          budget -= g.matches.length;
        }

        return ok({
          total,
          shown: Math.min(total, GREP_MAX_MATCHES),
          ...(truncated ? { truncated: true } : {}),
          groups: shownGroups,
          ...(notes.length ? { note: notes.join('；') } : {}),
        });
      } catch (err: any) {
        return fail(err?.message ?? String(err));
      }
    },
  });
}
