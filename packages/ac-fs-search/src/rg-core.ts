// ============================================================
// ac-fs-search/src/rg-core.ts —— ripgrep 引擎纯库（零 cordis 依赖）
//
// cr-678：grep 主路径改 spawn ripgrep（@vscode/ripgrep vendored 二进制，
// 平台子包 optionalDependencies 装配——无 postinstall、无运行时网络），
// 纯 Node 遍历降级为回退路径。口径对齐（Windows 实测定案）：
//   · --hidden --no-ignore——含隐藏文件、不读 .gitignore（现状 walk 口径）；
//   · 排除 glob（!**/node_modules/** 等）以 cwd 为基准——spawn cwd 设为搜索
//     根，path 直指跳过目录时其内部路径不含该段名，自动恢复「path 直指即
//     全搜」语义（与现状 walkFiles 跳过目录仅在根层之下生效一致）；
//   · 显式文件参数不受 glob 过滤（现状：include 不适用于单文件目标）；
//   · include 按 basename 匹配（现状口径）。rg glob 含 / 时按相对 cwd 的
//     路径匹配，basename 语义需自转：*.ts → **/*.ts。
// 子进程纪律：流式计数到 hardCap 即 kill（rg 无总量上限参数）；AbortSignal
// 中止同 kill——不留孤儿（shell-orphan 红线）。JSON 事件流逐行解析。
// ============================================================
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
// 消费证据（check-deps R4）：二进制路径经下方 require.resolve 动态解析
//（平台子包缺席需优雅降级而非模块级抛错，故不做值导入）；此 type-only
// import 声明依赖关系——删掉声明 pnpm 不装平台子包，rg 主路径静默退化。
import type {} from '@vscode/ripgrep';

let cachedRgPath: string | undefined;
let rgResolved = false;

/** rg 可执行路径解析（懒缓存；失败返回 undefined——调用方走 Node 回退） */
export function resolveRgPath(): string | undefined {
  if (rgResolved) return cachedRgPath;
  rgResolved = true;
  try {
    const require = createRequire(import.meta.url);
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    cachedRgPath = require.resolve(
      `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binaryName}`,
    );
  } catch {
    cachedRgPath = undefined; // 平台子包缺席（安装残缺/不支持平台）——回退
  }
  return cachedRgPath;
}

export interface RgMatch {
  line: number;
  preview: string;
}

export interface RgFileGroup {
  /** 相对基准的 posix 路径（行层 toPosixRel 产出——与 Node 路径口径一致） */
  path: string;
  matches: RgMatch[];
}

export interface RunRgOptions {
  /** 正则源（行层已编译校验过的原样 pattern） */
  pattern: string;
  /** 字面量模式（-F） */
  fixed: boolean;
  /** 搜索目标绝对路径（目录或文件） */
  targetAbs: string;
  // 排除 glob 列表（cwd 基准；形如「任意深度 node_modules 目录」的否定 glob——行层组装）
  excludeGlobs: string[];
  /** include glob（basename 匹配；含 / 的 include 已由行层转 basename 段——见行层注释） */
  includeGlob?: string;
  /** 收集硬顶（达到即 kill——结果标 truncated） */
  hardCap: number;
  /** 中止信号（loop  透传；触发即 kill） */
  signal?: AbortSignal;
  /** 每行预览字符上限（JSON 模式 rg 不截断——自行 slice） */
  maxLineChars: number;
  /** rg 输出的绝对路径 → 相对 baseAbs 的 posix 相对路径（基准外回退相对 target） */
  toPosixRel: (abs: string) => string;
}

export interface RunRgResult {
  groups: RgFileGroup[];
  total: number;
  truncated: boolean;
}

const PREVIEW_ELLIPSIS = '…(line truncated)';

function previewOf(line: string, maxChars: number): string {
  return line.length > maxChars ? line.slice(0, maxChars) + PREVIEW_ELLIPSIS : line;
}

interface ParsedMatch {
  rawPath: string;
  lineNo: number;
  rawText: string;
}

/** 解析 rg --json 的 match 事件行（其余事件类型返回 undefined） */
function parseMatchEvent(line: string): ParsedMatch | undefined {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return undefined; // 非完整 JSON 行（理论上不出现——rg 按行 flush）
  }
  if (ev === null || typeof ev !== 'object' || !('type' in ev)) return undefined;
  const e = ev as { type: string; data?: unknown };
  if (e.type !== 'match' || e.data === null || typeof e.data !== 'object') return undefined;
  const d = e.data as {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
  const rawPath = d.path?.text;
  const lineNo = d.line_number;
  const rawText = d.lines?.text;
  if (typeof rawPath !== 'string' || typeof lineNo !== 'number' || typeof rawText !== 'string') {
    return undefined;
  }
  return { rawPath, lineNo, rawText };
}

/**
 * spawn rg 执行搜索（JSON 事件流），只消费 match 事件。退出码：0=有匹配、
 * 1=无匹配、2=错误（错误抛出——行层决定回退或报错；hardCap kill 视为截断）。
 * stderr 原样丢弃（rg 的进度/告警不面向模型）。
 */
export async function runRg(opts: RunRgOptions): Promise<RunRgResult> {
  const rgPath = resolveRgPath();
  if (rgPath === undefined) throw new Error('rg-not-available');
  const args: string[] = ['--json', '--hidden', '--no-ignore', '-e', opts.pattern];
  if (opts.fixed) args.push('-F');
  for (const g of opts.excludeGlobs) args.push('--glob', g);
  if (opts.includeGlob !== undefined) args.push('--glob', opts.includeGlob);
  const isFile = fileExistsNonDir(opts.targetAbs);
  args.push(isFile ? opts.targetAbs : '.');
  return await new Promise<RunRgResult>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: isFile ? path.dirname(opts.targetAbs) : opts.targetAbs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const spawnCwd = isFile ? path.dirname(opts.targetAbs) : opts.targetAbs;
    const groups: RgFileGroup[] = [];
    const total = { n: 0 };
    let truncated = false;
    let pending = '';
    let settled = false;
    let killed = false;
    const killChild = (): void => {
      if (!killed && child.exitCode === null && !child.killed) {
        killed = true;
        child.kill();
      }
    };
    const onAbort = (): void => {
      killChild();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf-8');
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (total.n >= opts.hardCap) {
          truncated = true;
          killChild();
          return;
        }
        const ev = parseMatchEvent(line);
        if (ev === undefined) continue;
        // 路径归一：rg 目录搜索（传 .）输出 cwd 相对路径（Windows 实测 .\x 形态），
        // 显式文件参数输出绝对路径——统一 resolve 成绝对再交 toPosixRel。
        const abs = path.isAbsolute(ev.rawPath) ? ev.rawPath : path.resolve(spawnCwd, ev.rawPath);
        const rel = opts.toPosixRel(abs);
        const group = groups.find((g) => g.path === rel);
        if (group === undefined) {
          groups.push({ path: rel, matches: [] });
        }
        const g = groups[groups.length - 1]!;
        // 预览口径与 Node 路径一致：剥尾 \n、保留 \r（CRLF 文件预览带 \r——既有行为）
        const text = ev.rawText.endsWith('\n') ? ev.rawText.slice(0, -1) : ev.rawText;
        g.matches.push({ line: ev.lineNo, preview: previewOf(text, opts.maxLineChars) });
        total.n++;
      }
    });
    child.on('error', (err: Error) => {
      settle(() => reject(new Error(`rg spawn 失败: ${err.message}`)));
    });
    child.on('close', (code: number | null) => {
      settle(() => {
        if (killed || code === 0 || code === 1) {
          resolve({ groups, total: total.n, truncated });
          return;
        }
        // 退出码 2：rg 报错（坏正则不会到这——行层已编译校验；多为环境性）。
        // 回退语义由行层决定：这里如实抛出。
        reject(new Error(`rg 退出码 ${code}`));
      });
    });
  });
}

/** 目标存在且非目录（目录/不存在 → false：按目录搜索或行层已报路径错误） */
function fileExistsNonDir(p: string): boolean {
  try {
    return !fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
