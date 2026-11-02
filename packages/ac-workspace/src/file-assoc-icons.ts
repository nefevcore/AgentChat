// ============================================================
// ac-workspace/src/file-assoc-icons.ts —— 文件关联原生图标（cr-833）
//（纯模块零 cordis 依赖——与 open-targets.ts 同族形态：行为面由单测全量锁定）
//
// 语义：树节点文件图标 = 本机文件关联决议——回答「这个扩展名在本机
// 关联到哪个应用、用什么图标」。ProgID 决议序（三层）：UserChoice（用户
// 显式选择，遮蔽一切）→ HKCR\<.ext> 默认值（机器级默认 ProgID）→
// OpenWithProgids 值名（应用自注册候选——.md 无默认值时 VSCode.md 在这）。
// 拿到 ProgID 后查 HKCR\<ProgID>\DefaultIcon 取图标源。任一跳缺席 = null
// （前端回落静态表）。UWP @{package} 形态放弃（不做 package 解析——dsh 对
// UWP 也只走 SHAssocEnumHandlers 特道，超出本期范围）。
// 提取复用 open-targets 共享管线 extractExeIconPng（path,index 形态，%VAR% 由
// 提取端 PowerShell 解析）。
// ============================================================
import { spawn } from 'node:child_process';
import { extractExeIconPng } from './open-targets.ts';

/** DefaultIcon 源形态（注册表 "path,index"；索引缺席 = 0） */
export interface IconSource { source: string; index: number; }

/** 关联探针 seam（TargetProbe 同款：纯函数注入口——测试离线锁行为面） */
export interface AssocProbe {
  platform: NodeJS.Platform;
  /** 注册表键默认值读取（reg.exe query <key> /ve 原始输出；null = 查询失败） */
  regDefault: (key: string) => Promise<string | null>;
  /** 注册表键命名值读取（reg.exe query <key> /v <name>；null = 查询失败/值缺席） */
  regValueOf: (key: string, name: string) => Promise<string | null>;
  /** 注册表键值名枚举（reg.exe query <key> 不带 /ve 的值名清单；null = 失败） */
  regValueNames: (key: string) => Promise<string[] | null>;
}

// ── 注册表读取（生产实现；open-targets regQuery 同形——它不导出故同形内联）──

/** spawn reg.exe（参数数组无 shell——防注入同 open-targets regQuery） */
function regSpawn(key: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', key, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (c: Buffer) => { buf += c.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(buf));
  });
}

/** 生产 probe（进程事实） */
export function productionAssocProbe(): AssocProbe {
  return {
    platform: process.platform,
    regDefault: (k) => regSpawn(k, ['/ve']),
    regValueOf: (k, n) => regSpawn(k, ['/v', n]),
    regValueNames: regQueryValueNames,
  };
}

/** reg 输出取默认值数据（REG_SZ/REG_EXPAND_SZ 行数据列；本地化安全——open-targets parseAppPathValue 同形） */
export function parseRegDefaultValue(out: string): string | null {
  const m = /^\s+\(.*\)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/m.exec(out);
  if (m === null) return null;
  const v = m[2].trim();
  if (v === '') return null;
  // 括号占位形态 = 「(值未设置)」本地化文案（GBK 乱码仍是括号包裹）——判为未设置
  if (v.startsWith('(') && v.endsWith(')')) return null;
  return v.replace(/^"+/, '').replace(/"+$/, '');
}

/** reg query（不带 /ve）输出取值名清单（第一列非括号项；空键 = []） */
export function parseRegValueNames(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split('\r\n')) {
    const m = /^\s{4}([^\s][^\r\n]*?)\s{2,}(REG_\w+)\s/.exec(line);
    if (m === null) continue;
    const name = m[1].trim();
    if (name === '(Default)' || name === '(默认)') continue;
    names.push(name);
  }
  return names;
}

/** reg query 值名枚举（生产实现） */
async function regQueryValueNames(key: string): Promise<string[] | null> {
  const out = await regSpawn(key, []);
  return out === null ? null : parseRegValueNames(out);
}

/** 首尾引号剥离（DefaultIcon 路径常带引号；idx 尾巴也可能带） */
function stripQuotes(s: string): string {
  return s.replace(/^"+/, '').replace(/"+$/, '');
}

/** DefaultIcon 值解析（"path,0" / "path,-3" / 裸路径 / 无索引尾巴） */
export function parseDefaultIcon(value: string): IconSource | null {
  const v = value.trim();
  if (v === '') return null;
  if (v.startsWith('@{')) return null; // UWP package 形态：放弃
  if (v === '%1') return null; // 文件自身图标占位（无文件实例可提）
  const comma = v.lastIndexOf(',');
  if (comma === -1) return { source: stripQuotes(v), index: 0 };
  const idxRaw = v.slice(comma + 1).trim();
  const pathPart = stripQuotes(v.slice(0, comma).trim());
  const idxPart = stripQuotes(idxRaw);
  // 负索引 = 资源 ID（MAKEINTRESOURCE 形态）——SHDefExtractIcon 直接受负值
  const n = /^-?\d+$/.test(idxPart) ? parseInt(idxPart, 10) : NaN;
  if (Number.isNaN(n)) return { source: stripQuotes(v), index: 0 };
  return { source: pathPart, index: n };
}

/**
 * 扩展名 → DefaultIcon 源（三层 ProgID 决议：UserChoice → HKCR\<.ext> 默认值 →
 * OpenWithProgids 值名）。全链 win-only（非 win = null）。
 */
export async function assocIconSourceOfExt(ext: string, probe: AssocProbe): Promise<IconSource | null> {
  if (probe.platform !== 'win32') return null;
  const dot = ext.startsWith('.') ? ext : '.' + ext;
  // 层 1：UserChoice ProgId 命名值（用户级显式选择，遮蔽机器级）
  const ucKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\' + dot + '\\UserChoice';
  const ucOut = await probe.regValueOf(ucKey, 'ProgId');
  let progId = ucOut === null ? null : parseRegDefaultValue(ucOut);
  if (!progId) {
    // 层 2：HKCR\<.ext> 默认值（机器级默认 ProgID）
    const extOut = await probe.regDefault('HKCR\\' + dot);
    progId = extOut === null ? null : parseRegDefaultValue(extOut);
  }
  const candidates: string[] = [];
  if (progId) candidates.push(progId);
  else {
    // 层 3：OpenWithProgids 值名（应用自注册候选，逐个尝试——首个有 DefaultIcon 的胜出；
    // AppX UWP ProgID 通常无 DefaultIcon，自然跳过）
    const names = await probe.regValueNames('HKCR\\' + dot + '\\OpenWithProgids');
    if (names !== null) candidates.push(...names);
  }
  for (const pid of candidates) {
    const diOut = await probe.regDefault('HKCR\\' + pid + '\\DefaultIcon');
    const raw = diOut === null ? null : parseRegDefaultValue(diOut);
    if (raw === null) continue;
    const src = parseDefaultIcon(raw);
    if (src !== null) return src;
  }
  return null;
}

// ── 图标缓存（进程内；ext → iconSource + iconSource+index → dataURL 双层）──

const sourceCache = new Map<string, IconSource | null>();
const pngCache = new Map<string, string | null>();

/** 缓存键（source+index 唯一——不同 ext 同源去重） */
function pngCacheKey(src: IconSource): string { return src.source + '#' + src.index; }

async function pngOf(src: IconSource): Promise<string | null> {
  const key = pngCacheKey(src);
  if (pngCache.has(key)) return pngCache.get(key) ?? null;
  const b64 = await extractExeIconPng(src.source, src.index);
  const url = b64 === null ? null : 'data:image/png;base64,' + b64;
  pngCache.set(key, url);
  return url;
}

/**
 * 扩展名 → 原生图标 dataURL（win：三层 ProgID 决议 + 提取；null = 前端回落静态表）。
 * 进程内双层缓存：ext → source（两跳查询）；source+index → dataURL（提取）。
 * 图标源里的 %VAR% 占位由提取端 PowerShell 解析（reg 值常含未展开变量）。
 */
export async function assocIconOfExt(ext: string, probe: AssocProbe = productionAssocProbe()): Promise<string | null> {
  if (sourceCache.has(ext)) {
    const cached = sourceCache.get(ext) ?? null;
    return cached === null ? null : await pngOf(cached);
  }
  const src = await assocIconSourceOfExt(ext, probe);
  sourceCache.set(ext, src);
  return src === null ? null : await pngOf(src);
}

/**
 * 目录行图标（cr-834）：HKCR\Directory\DefaultIcon（系统「文件夹」通用图标——
 * shell32.dll,3；explorer.exe 是资源管理器应用图标，两者语义不同）。进程内缓存。
 */
export async function folderIconOf(probe: AssocProbe = productionAssocProbe()): Promise<string | null> {
  if (folderIconCached !== undefined) return folderIconCached;
  let icon: string | null = null;
  if (probe.platform === 'win32') {
    const out = await probe.regDefault('HKCR\\Directory\\DefaultIcon');
    const raw = out === null ? null : parseRegDefaultValue(out);
    const src = raw === null ? null : parseDefaultIcon(raw);
    if (src !== null) icon = await pngOf(src);
  }
  folderIconCached = icon;
  return icon;
}
let folderIconCached: string | null | undefined;

/** 测试口：重置进程级缓存 */
export function resetAssocIconCache(): void {
  sourceCache.clear();
  pngCache.clear();
  folderIconCached = undefined;
}