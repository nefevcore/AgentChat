// ============================================================
// ac-fs-search/src/index.ts —— 文件检索工具行（glob/grep）
//
// DSH dsh-tool-fs-search 语义（src fs-search 平移，输出形态归一 {ok, output}）：
//   · glob —— 模式不含 "/" 匹配任意深度文件名；含 "/" 锚定相对搜索根；
//     只返回文件；mtime 新→旧；内联上限 100
//   · grep —— pattern 为 JS 正则；path 文件或目录；include 单个正向 glob
//     过滤器（拒绝逗号列表与否定值）；二进制跳过；内联上限 250 /
//     硬顶 2000 / 每行预览 2000 字符
// 检索算法住纯库 ac-glob-core；沙箱黑名单与 read/write 同口径
// （walk 逐文件过 isDenied——.env 等敏感文件不进结果）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import { createAgentSandboxCache, type SandboxResolverOptions, type SandboxWorkdirSource } from 'ac-sandbox-core';
import { globToRegExp, normalizeGlobPattern, walkFiles, type WalkEntry } from 'ac-glob-core';

export interface FsSearchRowOptions extends SandboxResolverOptions {}

/** glob 内联展示上限（与 DSH globMaxResults / Claude Code GlobTool 相同） */
const GLOB_MAX_RESULTS = 100;
/** grep 内联匹配上限（与 DSH grepMaxMatches 相同） */
const GREP_MAX_MATCHES = 250;
/** grep 匹配收集硬顶（超出停止扫描并标记 truncated） */
const GREP_HARD_CAP = 2000;
/** grep 每行预览字符上限（与 DSH grepMaxLineBytes 同值） */
const GREP_MAX_LINE_CHARS = 2000;
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

/** 校验 include 参数：单个正向 glob（拒绝顶层逗号列表与 ! 否定；花括号交替内逗号允许） */
function compileInclude(include: string): RegExp {
  if (include.startsWith('!')) {
    throw new Error('include 不支持否定值（!…）；请提供正向 glob，如 "*.ts" 或 "*.{ts,tsx}"');
  }
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
  return line.length > GREP_MAX_LINE_CHARS ? line.slice(0, GREP_MAX_LINE_CHARS) + '…(line truncated)' : line;
}

/** 在单文件中收集匹配（写入 sink；无匹配则 sink 为空） */
function searchFile(abs: string, regex: RegExp, sink: LineMatch[]): void {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return;
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return; // 二进制：跳过
  const lines = buf.toString('utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    sink.push({ line: i + 1, preview: previewOf(lines[i]) });
  }
}

export const name = 'ac-fs-search';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'fs-search',
  label: '文件检索',
  description: '文件检索工具行（glob/grep）',
};

export const inject = ['tools'];

export function apply(ctx: Context, options: FsSearchRowOptions = {}) {
  // 沙箱解析基准（M18 反馈 #3）：Agent 专用空间（ac-workspace.sandboxWorkdir
  // 唯一事实源；缺 → 行缺省）。按基准缓存解析器（共用实现住 ac-sandbox-core）。
  const sandboxOf = createAgentSandboxCache(options, () =>
    ctx.get('workspace') as SandboxWorkdirSource | undefined,
  );

  // ---- glob：按路径模式找文件 ----
  ctx.tools.register({
    name: 'glob',
    description: '按 glob 模式查找文件（如 "**/*.ts"；模式不含 / 时匹配任意深度的文件名）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"、"*.test.ts"' },
        path: { type: 'string', description: '搜索根目录（默认当前工作目录）' },
      },
      required: ['pattern'],
    },
    async execute(args, call) {
      // 工具体抛错（沙箱越界等）由 ac-tools 统一收敛为 { ok:false, error }
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return { ok: false, error: '缺少 pattern 参数（不能为空）' };

      const sandbox = sandboxOf(call);
      const rootInput = String(args.path ?? '.');
      const rootAbs = sandbox.resolve(rootInput);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(rootAbs);
      } catch {
        return { ok: false, error: `路径不存在: ${rootInput}` };
      }
      if (!stat.isDirectory()) {
        return { ok: false, error: `path 必须是目录（glob 只按模式发现文件）: ${rootInput}` };
      }

      const normalized = normalizeGlobPattern(pattern);
      if (!normalized) return { ok: false, error: 'pattern 不能为空' };
      const matchBase = !normalized.includes('/');
      let re: RegExp;
      try {
        re = globToRegExp(normalized);
      } catch (err: unknown) {
        return { ok: false, error: `无效的 glob 模式 "${pattern}": ${String(err)}` };
      }

      const { entries, capped } = walkFiles(rootAbs, {
        base: sandbox.workdir,
        isDenied: (abs) => sandbox.isDenied(abs),
      });
      const matched = entries.filter((e) =>
        re.test(matchBase ? e.rel.slice(e.rel.lastIndexOf('/') + 1) : e.rel),
      );
      // 修改时间新→旧；同 mtime 按路径稳定排序
      matched.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

      const shown = matched.slice(0, GLOB_MAX_RESULTS);
      const notes: string[] = [];
      if (matched.length === 0) notes.push('No files found（未找到匹配文件，可放宽模式或换搜索根）');
      else if (matched.length > shown.length) {
        notes.push(`共 ${matched.length} 条匹配，仅展示最新的 ${shown.length} 条（按修改时间）`);
      }
      if (capped) notes.push(`扫描在 ${entries.length} 个文件处截断（病态大目录？可用 path 收窄搜索根）`);

      return {
        ok: true,
        output: {
          root: rootInput,
          total: matched.length,
          shown: shown.length,
          paths: shown.map((e) => e.rel),
          ...(notes.length > 0 ? { note: notes.join('；') } : {}),
        },
      };
    },
  });

  // ---- grep：按内容找文件 ----
  ctx.tools.register({
    name: 'grep',
    description: '按正则表达式搜索文件内容（结果按文件分组，Line N: 预览）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JS RegExp 语法）' },
        path: { type: 'string', description: '搜索的文件或目录（默认当前工作目录）' },
        include: { type: 'string', description: '文件名过滤 glob，如 "*.ts"' },
      },
      required: ['pattern'],
    },
    async execute(args, call) {
      // 工具体抛错由 ac-tools 统一收敛为 { ok:false, error }——不整体 try/catch
      const pattern = String(args.pattern ?? '');
      if (!pattern.trim()) return { ok: false, error: '缺少 pattern 参数（不能为空）' };

      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err: unknown) {
        return { ok: false, error: `无效的正则表达式 "${pattern}": ${String(err)}` };
      }

      let includeRe: RegExp | undefined;
      if (args.include !== undefined) {
        if (typeof args.include !== 'string' || !args.include.trim()) {
          return { ok: false, error: 'include 必须是非空 glob 字符串' };
        }
        try {
          includeRe = compileInclude(args.include.trim());
        } catch (err: unknown) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      const sandbox = sandboxOf(call);
      const targetInput = String(args.path ?? '.');
      const targetAbs = sandbox.resolve(targetInput);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(targetAbs);
      } catch {
        return { ok: false, error: `路径不存在: ${targetInput}` };
      }

      // 目标文件集合：单文件直搜（include 不适用）；目录走有界遍历 + include 过滤
      let targets: WalkEntry[];
      let capped = false;
      if (stat.isFile()) {
        const rel = path.relative(sandbox.workdir, targetAbs);
        targets = [
          {
            abs: targetAbs,
            rel: rel.startsWith('..') || path.isAbsolute(rel) ? targetAbs.replace(/\\/g, '/') : rel.replace(/\\/g, '/'),
            mtimeMs: 0,
          },
        ];
      } else if (stat.isDirectory()) {
        const walked = walkFiles(targetAbs, {
          base: sandbox.workdir,
          isDenied: (abs) => sandbox.isDenied(abs),
        });
        targets = includeRe
          ? walked.entries.filter((e) => includeRe!.test(e.rel.slice(e.rel.lastIndexOf('/') + 1)))
          : walked.entries;
        capped = walked.capped;
      } else {
        return { ok: false, error: `path 既不是文件也不是目录: ${targetInput}` };
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

      return {
        ok: true,
        output: {
          total,
          shown: Math.min(total, GREP_MAX_MATCHES),
          ...(truncated ? { truncated: true } : {}),
          groups: shownGroups,
          ...(notes.length > 0 ? { note: notes.join('；') } : {}),
        },
      };
    },
  });
}
