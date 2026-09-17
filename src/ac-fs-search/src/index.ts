// ============================================================
// ac-fs-search/src/index.ts —— 文件检索工具行（glob/grep）
//
// DSH dsh-tool-fs-search 语义（src fs-search 平移，输出形态归一 {ok, output}）：
//   · glob —— 模式不含 "/" 匹配任意深度文件名；含 "/" 锚定相对搜索根；
//     只返回文件；mtime 新→旧；内联上限 100
//   · grep —— pattern 为 JS 正则；path 文件或目录；include 单个正向 glob
//     过滤器（拒绝逗号列表与否定值）；二进制跳过；内联上限 250 /
//     硬顶 2000 / 每行预览 2000 字符
// 检索算法住纯库 ac-glob-core。access-tier §9.1/§9.2：检索面读不设防
// （搜索根脱离工作区沙箱——相对路径仍按锚点解析），敏感面 = 双黑名单
// **结果过滤**（accessDeny 全档 + readDeny 非 full 档；只查参数拦不住
// 目录扫描——deny 目录前缀判定覆盖子树）。
// ============================================================
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import type { Context } from '@agentchat/cordis';
import {
  accessDenyPatterns,
  createAgentSandboxCache,
  denyExtrasOf,
  isDeniedPath,
  readDenyPatterns,
  type SandboxResolverOptions,
  type SandboxWorkdirSource,
} from 'ac-sandbox-core';
import { effectiveTierOf } from 'ac-agents';
import type { AgentConfig } from 'ac-agents';
import { globToRegExp, literalDirPrefix, normalizeGlobPattern, walkFiles, type WalkEntry } from 'ac-glob-core';

export interface FsSearchRowOptions extends SandboxResolverOptions {
  /** 追加访问黑名单（读+写双禁；系统默认表随 workspace 锚定自动内置） */
  accessDenyPaths?: string[];
  /** 追加读黑名单（仅读禁；默认表 .env 系/密钥文件模式自动内置） */
  readDenyPaths?: string[];
}

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
/** 流式扫描块大小 */
const GREP_CHUNK_BYTES = 1 << 18;
/** 整缓冲+预筛路径的字节上限（更大走流式行扫描，防内存峰值） */
const GREP_PREFILTER_MAX_BYTES = 1 << 20;

/**
 * 正则必需字面量（保守提取）：顶层（括号深度 0、字符类外）串联出现的
 * 字面量运行，且不被 `*`/`?`/`{…}` 修饰掉尾字符。文件全文不含任一运行
 * ⇒ 正则必不匹配 ⇒ 免正则整文件跳过（includes 预筛远快于逐行 split+test）。
 * 出现顶层 `|` / 结构异常 → 返回 []（放弃预筛，行为与纯正则一致——
 * 预筛只允许漏掉「不可能匹配」，不允许放过任何真匹配）。
 * 提取规则：`\x`（x 标点）计入字面量；`\d` 等预定义类/断言只断开运行；
 * `(` 前运行保留（组本身必需，除非其后有量词——量词只作用于组不影响
 * 组前运行）；`)` 于深度 0 = 结构异常，整体放弃。
 */
function requiredLiterals(pattern: string): string[] {
  const runs: string[] = [];
  let run = '';
  let depth = 0;
  let inClass = false;
  const MIN_LEN = 2; // 短运行区分度低，预筛价值小
  const flush = (trimTail: boolean): void => {
    if (trimTail && run.length > 0) run = run.slice(0, -1); // 尾字符被量词转为可选
    if (run.length >= MIN_LEN) runs.push(run);
    run = '';
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (inClass) {
      if (ch === '\\') i++; // 类内转义：跳过下一字符
      else if (ch === ']') {
        inClass = false;
        flush(false); // 字符类必消费 1 字符，仅断开运行
      }
      continue;
    }
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) break; // 尾悬反斜杠：交给 new RegExp 报错
      if (/[a-zA-Z]/.test(next)) {
        flush(false); // \d \w \b \n 等：类/断言，非字面量
      } else {
        run += next; // \( \. \* 等：标点字面量
      }
      i++;
      continue;
    }
    switch (ch) {
      case '[':
        inClass = true;
        flush(false);
        break;
      case '(':
        depth++;
        flush(false);
        break;
      case ')':
        if (depth === 0) return []; // 结构异常：放弃
        depth--;
        flush(false);
        break;
      case '|':
        if (depth === 0) return []; // 顶层交替：无公共必需字面量
        flush(false);
        break;
      case '*':
      case '?':
        flush(true); // 前一字符（运行尾或单原子）转为可选
        break;
      case '{': {
        // {m,M}：m===0 时尾字符可选；解析保守——min 0 才截尾
        flush(/\{\s*0\s*[,}]/.test(pattern.slice(i)) ? true : false);
        break;
      }
      case '.':
      case '^':
      case '$':
      case '+':
      case '}':
        flush(false); // 断开运行（不改变已累积字面量的必需性）
        break;
      default:
        run += ch;
    }
  }
  if (depth !== 0) return []; // 未闭合括号：结构异常，放弃
  flush(false);
  return runs;
}

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

/**
 * 在单文件中收集匹配（写入 sink；无匹配则 sink 为空）。
 * 双轨：小文件（≤1MB）整读 + 必需字面量全文预筛（不含即免正则跳过——
 * 正则匹配 ⇒ 每个必需字面量都在全文中出现，预筛只加速不减命中）；
 * 大文件流式行扫描（按需读块，StringDecoder 处理跨块多字节字符；
 * 文件含 \r\n 时预览带 \r——与整缓冲路径一致）。多行标志（m）不参与
 * 预筛（$ 按整缓冲语义，预筛按全文口径保守成立）。
 * budget = 收集上限（调用方剩余硬顶额度），返回实际收集数。
 */
function searchFile(
  abs: string,
  regex: RegExp,
  sink: LineMatch[],
  literals: readonly string[],
  budget: number,
): number {
  let size = 0;
  try {
    size = fs.statSync(abs).size;
  } catch {
    return 0;
  }

  if (size <= GREP_PREFILTER_MAX_BYTES) {
    // 小文件：单次整读；探测窗/预筛/逐行全在缓冲上（无二次 IO）
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return 0;
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0; // 二进制：跳过
    const text = buf.toString('utf-8');
    for (const lit of literals) {
      if (!text.includes(lit)) return 0; // 必需字面量缺位：正则必不匹配
    }
    const lines = text.split('\n');
    const before = sink.length;
    for (let i = 0; i < lines.length && sink.length - before < budget; i++) {
      if (!regex.test(lines[i])) continue;
      sink.push({ line: i + 1, preview: previewOf(lines[i]) });
    }
    return sink.length - before;
  }

  // 大文件：单个 fd 顺序读；首块兼作二进制探测窗（前 8KB 含 NUL 即弃），
  // StringDecoder 处理跨块多字节字符；分块字面量预筛——「块解码文本（含
  // 跨块 pending）不含必需字面量 ⇒ 其中任何完整行都不含 ⇒ 无匹配」，
  // 免 split+正则只推进行号（大文本文件的主体开销在 split+逐行 test）。
  // budget 用尽即停（行级粒度）。
  let collected = 0;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const decoder = new StringDecoder('utf-8');
      const chunk = Buffer.allocUnsafe(GREP_CHUNK_BYTES);
      let pending = ''; // 跨块未完结的行
      let lineNo = 1;
      let sniffed = false;
      const useLits = literals.length > 0;
      const scanLine = (line: string): boolean => {
        if (collected >= budget) return false;
        if (regex.test(line)) {
          sink.push({ line: lineNo, preview: previewOf(line) });
          collected++;
        }
        lineNo++;
        return true;
      };
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (n <= 0) break;
        const data = chunk.subarray(0, n);
        if (!sniffed) {
          sniffed = true;
          if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0; // 二进制
        }
        const text = pending + decoder.write(data);
        if (useLits && !literals.every((lit) => text.includes(lit))) {
          // 无匹配可能：免 split/正则，仅推进行号与未完结尾段
          let idx = -1;
          let last = -1;
          while ((idx = text.indexOf('\n', idx + 1)) !== -1) {
            lineNo++;
            last = idx;
          }
          pending = text.slice(last + 1);
          continue;
        }
        const lines = text.split('\n');
        pending = lines.pop() ?? ''; // 末段可能未完结，留待下块
        for (const line of lines) {
          if (!scanLine(line)) {
            decoder.end();
            return collected;
          }
        }
      }
      const tail = pending + decoder.end(); // 末块残余 + 不完整多字节序列
      scanLine(tail); // 尾行（可能空——与 split('\n') 的末元素口径一致）
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return collected; // 读取中断：保留已收集
  }
  return collected;
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

  /** agents 软依赖（档位判定 tierOf 单源） */
  const agentsOf = (): { get(id: string): AgentConfig | undefined } | undefined =>
    ctx.get('agents', false) as { get(id: string): AgentConfig | undefined } | undefined;

  /** workspace 不可用的告警只发一次（基线 best-effort；ac-security 加严层
   *  对 workspace 缺失 fail-closed 兜底） */
  let warnedNoWorkspace = false;

  /**
   * 检索面黑名单判定（§9.2 双黑名单结果过滤，glob/grep 共用）：
   * accessDeny（系统域，全档）+ readDeny（用户域机密，非 full 档）。
   * 目录前缀判定覆盖子树（agents/ 等持久化域树整树过滤）。
   */
  function searchDenyFilterOf(call: { agentId?: string; elevation?: string }): (abs: string) => boolean {
    // root 防御性校验：mock/部分实现可能无 root（非 string = 视同未装，
    // best-effort 跳过系统部分——加严层 fail-closed 兜底）
    const wsRaw = ctx.get('workspace') as { root?: unknown } | undefined;
    const root = typeof wsRaw?.root === 'string' ? wsRaw.root : undefined;
    const agents = agentsOf() as ({ settingsOf?(id: string, name?: string): unknown } | undefined);
    const s = call.agentId !== undefined ? agents?.settingsOf?.(call.agentId, 'security') : undefined;
    const extras = denyExtrasOf(s);
    const accessExtra = [...(options.accessDenyPaths ?? []), ...extras.accessDenyPaths];
    const readExtra = [...(options.readDenyPaths ?? []), ...extras.readDenyPaths];
    if (root === undefined && !warnedNoWorkspace) {
      warnedNoWorkspace = true;
      ctx.logger.warn(
        '[fs-search] workspace 服务不可用：检索黑名单系统域部分（控制面/持久化域）无法锚定数据根——基线仅检查追加项（best-effort；ac-security 行如装载则 fail-closed 兜底）。',
      );
    }
    const accessDeny = root !== undefined ? accessDenyPatterns(root, accessExtra) : accessExtra;
    const readDeny = readDenyPatterns(readExtra);
    const agent = call.agentId !== undefined ? agentsOf()?.get(call.agentId) : undefined;
    const tier = effectiveTierOf(
      agent,
      call.elevation === 'full-access' ? 'full-access' : call.elevation === 'sandbox-access' ? 'sandbox-access' : undefined,
    );
    const skipReadDeny = tier === 'full-access';
    return (abs: string): boolean =>
      isDeniedPath(accessDeny, abs) || (!skipReadDeny && isDeniedPath(readDeny, abs));
  }

  // ---- glob：按路径模式找文件 ----
  // fs 标签（2026-09-16 全量标签化）：文件族门禁
  ctx.tools.register({
    name: 'glob',
    requiredTags: ['fs'],
    description:
      '按 glob 模式查找文件（如 "**/*.ts"；模式不含 / 时匹配任意深度的文件名）。'
      + 'output: { root, total, shown, paths: Array<string> }——paths 相对工作区锚点（不是搜索根），按修改时间新→旧，内联上限 100；paths 条目可直接作为 read/grep 的相对路径参数（同锚点解析）。',
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
      const isDenied = searchDenyFilterOf(call);
      const rootInput = String(args.path ?? '.');
      // 读不设防（§9.1）：搜索根脱离工作区沙箱——相对路径按锚点解析，
      // 只过双黑名单（根自身命中即拒；子树由 walk 逐文件过滤）
      const rootAbs = path.resolve(sandbox.workdir, rootInput);
      if (isDenied(rootAbs)) {
        return { ok: false, error: `搜索根被黑名单拒绝（系统域/机密）：${rootInput}` };
      }
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

      // 目录剪枝：字面量目录前缀之外的子树整树不进入（如 `src/ac-*/**` 的
      // 'src'）。逐段校验（深度对齐——父级已匹配是 descend 的前提，归纳保证
      // 只查当前段即可）；深于前缀（d ≥ litDirs.length）不剪、自由下探；
      // matchBase（模式不含 /，按文件名匹配任意深度）不剪。
      const litDirs = matchBase ? null : literalDirPrefix(normalized);
      const pruneDir =
        litDirs === null
          ? undefined
          : (name: string, rel: string): boolean => {
              const d = rel.lastIndexOf('/') + 1; // 0 基段序：rel 深度 d+1
              return d < litDirs.length && name !== litDirs[d];
            };

      const { entries, capped } = walkFiles(rootAbs, {
        base: sandbox.workdir,
        isDenied,
        ...(pruneDir !== undefined ? { pruneDir } : {}),
      });
      const matched = entries.filter((e) =>
        re.test(matchBase ? e.rel.slice(e.rel.lastIndexOf('/') + 1) : e.rel),
      );
      // mtime 惰性补齐：仅对命中条目 stat（排序依据）——walk 不再全量逐文件 stat
      // （stat 次数 = 匹配数而非总文件数；竞争删除留空按 0 排序）
      for (const m of matched) {
        try {
          m.mtimeMs = fs.statSync(m.abs).mtimeMs;
        } catch {
          /* 竞争删除：留空 */
        }
      }
      // 修改时间新→旧；同 mtime 按路径稳定排序
      matched.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

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
    requiredTags: ['fs'],
    description:
      '按正则表达式搜索文件内容（结果按文件分组，Line N: 预览）。'
      + 'output: { total, groups: Array<{ path, matches: Array<{ line, preview }> }> }——path 相对工作区锚点，可直接作为 read 的相对路径参数；内联上限 250 条匹配。',
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
      const isDenied = searchDenyFilterOf(call);
      const targetInput = String(args.path ?? '.');
      // 读不设防（§9.1）：目标脱离工作区沙箱——相对路径按锚点解析，
      // 只过双黑名单（目录走 walk 逐文件过滤）
      const targetAbs = path.resolve(sandbox.workdir, targetInput);
      if (isDenied(targetAbs)) {
        return { ok: false, error: `搜索目标被黑名单拒绝（系统域/机密）：${targetInput}` };
      }
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
          },
        ];
      } else if (stat.isDirectory()) {
        const walked = walkFiles(targetAbs, {
          base: sandbox.workdir,
          isDenied,
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
      // 必需字面量预筛（小文件轨道；空数组 = 无可提取，等价关闭）
      const literals = requiredLiterals(pattern);
      for (const entry of targets) {
        if (total >= GREP_HARD_CAP) {
          truncated = true;
          break; // 硬顶已达：停止扫后续文件
        }
        const sink: LineMatch[] = [];
        const n = searchFile(entry.abs, regex, sink, literals, GREP_HARD_CAP - total);
        if (n === 0) continue;
        total += n;
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
