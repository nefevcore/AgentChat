// ============================================================
// ac-workspace/src/open-targets.ts —— 「打开方式」应用目录（cr-829）
//（纯模块：编译期固定目录表 + 平台解析 + 启动编排；零 cordis 依赖
//——与 native-open.ts 同族形态，行为面由单测全量锁定）
//
// 语义：与 dsh-host-open-in-app 同款裁决——目录编译期固定，不做无边界
// OS 应用枚举（能定位 ≠ 能接收路径参数，各 app 启动协议不同）；解析
// 惰性、每进程一次成 map，点击不重探测；启动遇 ENOENT 只重解析该条目
// 一次（卸载自愈），证不出即移除；新装应用要重启才出现（接受）。
//
// 目录表 6 条：explorer（cr-831 加入——文件=定位选中是 open-local 不覆盖的
// 独立场景）/ vscode / cursor / notepad（仅文件）/ windowsterminal（仅目录）/
// terminal（mac）。
//
// 启动编排：detached + stdio ignore + env 白名单 + 看护窗确认（窗内
// spawn error 优先、非零退出才算失败、窗关仍活 = 成功——前台常驻型
// 进程不能等退出，dsh launchDetachedApp 同思路）。env 白名单制：宿主
// process.env 有池凭据，白名单比黑名单剥除稳（漏一个词就泄漏）；
// Windows GUI 进程 env 太瘦会崩，白名单含 PATH/SYSTEMROOT/SYSTEMDRIVE/
// TEMP/TMP/LOCALAPPDATA/PROGRAMDATA/USERPROFILE/COMSPEC 等。
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { stat as fsStat } from 'node:fs/promises';
import { parentDirOf } from './native-open.ts';

/** 应用可用面：dir = 能接收目录参数 / file = 能接收文件参数 */
export type OpenTargetKind = 'dir' | 'file' | 'both';

/** 启动命令（argv 直启；目标路径追加在 args 尾部） */
export interface LaunchCommand {
  command: string;
  args: string[];
  /**
   * 文件目标时的替代参数（cr-831）：explorer 类「文件 = 定位选中」语义——
   * win `explorer /select,<file>` / mac `open -R` / linux 无选中协议
   * （退化打开父目录）。缺席 = args + 路径（常规形态）。
   */
  fileArgs?: (file: string) => string[];
}

/** 定位器（按序尝试；产出「已验证启动器」——本机实际持有，非裸安装记录） */
export type Locator =
  | { kind: 'fixed'; launch: LaunchCommand }
  | { kind: 'cli'; name: string; args: string[] }
  | { kind: 'file'; candidates: string[]; args: string[]; fileArgs?: (file: string) => string[] }
  | { kind: 'app-paths'; exe: string }
  | { kind: 'mac-app'; fsNames: string[] };

/** 目录表条目（纯数据；kind 由启动参数协议决定） */
export interface OpenTargetSpec {
  id: string;
  label: string;
  kind: OpenTargetKind;
  platforms: Partial<Record<NodeJS.Platform, ReadonlyArray<Locator>>>;
}

/** 解析结果（map 值；launch 可点击即用） */
export interface ResolvedTarget {
  id: string;
  label: string;
  kind: OpenTargetKind;
  launch: LaunchCommand;
}

// ── 目录表（菜单序：文件管理器 → 编辑器 → 终端；候选路径 ${VAR} 按进程 env 展开）──
export const OPEN_TARGET_CATALOG: ReadonlyArray<OpenTargetSpec> = [
  {
    id: 'explorer',
    label: '文件资源管理器',
    kind: 'both',
    platforms: {
      // 文件 = 定位选中（explorer /select,）；目录 = 打开。win 用 file 定位器
      // （绝对路径 + 磁盘验证——裸名 explorer.exe 无法过 ExtractAssociatedIcon）；
      // mac/linux fixed（open/xdg-open 是 PATH 恒在的 OS 随附件）
      win32: [{ kind: 'file', candidates: ['${SystemRoot}/explorer.exe'], args: [], fileArgs: (f) => ['/select,', f] }],
      darwin: [{ kind: 'fixed', launch: {
        command: 'open', args: ['-R'],
        fileArgs: (f) => ['-R', f],
      } }],
      linux: [{ kind: 'fixed', launch: {
        command: 'xdg-open', args: [],
        fileArgs: (f) => [parentDirOf(f)],
      } }],
    },
  },
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'both',
    platforms: {
      win32: [
        { kind: 'app-paths', exe: 'Code.exe' },
        { kind: 'file', candidates: ['${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe'], args: [] },
      ],
      darwin: [{ kind: 'mac-app', fsNames: ['Visual Studio Code.app'] }],
      linux: [{ kind: 'cli', name: 'code', args: [] }],
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'both',
    platforms: {
      win32: [
        { kind: 'app-paths', exe: 'Cursor.exe' },
        { kind: 'file', candidates: ['${LOCALAPPDATA}/Programs/cursor/Cursor.exe'], args: [] },
      ],
      darwin: [{ kind: 'mac-app', fsNames: ['Cursor.app'] }],
      linux: [{ kind: 'cli', name: 'cursor', args: [] }],
    },
  },
  {
    id: 'notepad',
    label: '记事本',
    kind: 'file',
    platforms: {
      win32: [{ kind: 'file', candidates: ['${SystemRoot}/System32/notepad.exe'], args: [] }],
    },
  },
  {
    id: 'windowsterminal',
    label: 'Windows 终端',
    kind: 'dir',
    platforms: {
      win32: [{ kind: 'cli', name: 'wt.exe', args: ['-d'] }],
    },
  },
  {
    id: 'terminal',
    label: '终端',
    kind: 'dir',
    platforms: {
      darwin: [{ kind: 'fixed', launch: { command: 'open', args: ['-a', 'Terminal'] } }],
    },
  },
];

/** 平台探测 seam（纯函数注入口；生产 = 进程事实，测试 = 假桩） */
export interface TargetProbe {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** 文件存在且是普通文件（file/app-paths 产物的磁盘验证） */
  isFile: (p: string) => Promise<boolean>;
  /** 目录存在（mac bundle 验证） */
  isDir: (p: string) => Promise<boolean>;
  /** PATH 名解析（cli 定位器；null = 不在 PATH） */
  which: (name: string) => Promise<string | null>;
  /** Windows App Paths 注册表查询（exe 名 → 绝对路径；null = 未注册） */
  appPathOf: (exe: string) => Promise<string | null>;
  /** macOS 应用目录（/Applications 与 ~/Applications） */
  applicationRoots: string[];
}

/** ${VAR} 展开（dsh expandCandidate 同款：引用未设变量 = null 整体放弃） */
export function expandCandidate(tpl: string, env: Record<string, string | undefined>): string | null {
  const missing: string[] = [];
  const expanded = tpl.replace(/\$\{([^}]+)\}/g, (whole: string, name: string) => {
    const v = env[name];
    if (v === undefined) { missing.push(name); return whole; }
    return v;
  });
  return missing.length > 0 ? null : expanded;
}

/**
 * 单条目解析（locator 链按序尝试，首个命中的「已验证启动器」胜出）。
 * 目标路径追加在 launch.args 尾部（wt -d <dir> / code <path>）。
 */
export async function resolveTarget(spec: OpenTargetSpec, probe: TargetProbe): Promise<ResolvedTarget | null> {
  const locators = spec.platforms[probe.platform];
  if (locators === undefined) return null;
  for (const loc of locators) {
    const launch = await locateLaunch(loc, probe);
    if (launch !== null) return { id: spec.id, label: spec.label, kind: spec.kind, launch };
  }
  return null;
}

/** 单定位器 → 启动命令（null = 证不出） */
async function locateLaunch(loc: Locator, probe: TargetProbe): Promise<LaunchCommand | null> {
  switch (loc.kind) {
    case 'fixed':
      return loc.launch;
    case 'cli': {
      const found = await probe.which(loc.name);
      return found === null ? null : { command: found, args: [...loc.args] };
    }
    case 'file': {
      for (const tpl of loc.candidates) {
        const p = expandCandidate(tpl, probe.env);
        if (p !== null && await probe.isFile(p)) return { command: p, args: [...loc.args], ...(loc.fileArgs !== undefined ? { fileArgs: loc.fileArgs } : {}) };
      }
      return null;
    }
    case 'app-paths': {
      const target = await probe.appPathOf(loc.exe);
      if (target === null || !await probe.isFile(target)) return null;
      return { command: target, args: [] };
    }
    case 'mac-app': {
      for (const root of probe.applicationRoots) {
        for (const name of loc.fsNames) {
          const bundle = root + "/" + name;
          if (await probe.isDir(bundle)) return { command: 'open', args: ['-a', bundle] };
        }
      }
      return null;
    }
  }
}

// ── 生产 probe（进程事实；reg.exe 参数数组无 shell——防注入同 dsh）──

/** reg.exe query 单键默认值读取（REG_* 类型标记定位值列——规避本地化「(默认)」文案） */
async function regQuery(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("reg.exe", ["query", key, "/ve"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    child.stdout.on("data", (c: Buffer) => { buf += c.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(buf));
  });
}

/** App Paths 查询：用户 hive → 机器 hive（每用户安装遮蔽机器级——同 dsh 序） */
async function regAppPath(exe: string): Promise<string | null> {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  ];
  for (const root of roots) {
    const out = await regQuery(root + "\\" + exe);
    if (out === null) continue;
    const v = parseAppPathValue(out);
    if (v !== null) return v;
  }
  return null;
}

/** reg 输出取默认值数据（REG_SZ/REG_EXPAND_SZ 行的数据列；本地化安全） */
function parseAppPathValue(out: string): string | null {
  const m = /^\s+\(.*\)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/m.exec(out);
  if (m === null) return null;
  const v = m[2].trim();
  return v === "" ? null : v.replace(/^"+/, "").replace(/"+$/, "");
}

/** PATH 名解析（进程内 stat 逐目录——无 shell/which 子进程，同 dsh） */
export async function whichInPath(
  name: string,
  env: Record<string, string | undefined>,
  isFile: (p: string) => Promise<boolean>,
): Promise<string | null> {
  const sep = env.PATH !== undefined && env.PATH.includes(";") ? ";" : ":";
  const exts = sep === ";" && env.PATHEXT !== undefined ? env.PATHEXT.split(";").filter(Boolean) : [""];
  for (const dir of (env.PATH ?? "").split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = dir + (dir.endsWith("/") || dir.endsWith("\\") ? "" : "/") + name + ext;
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 生产 probe：进程事实（fs stat / App Paths 注册表 / PATH 扫描） */
export function productionProbe(): TargetProbe {
  const isFile = async (p: string): Promise<boolean> => {
    try { return (await fsStat(p)).isFile(); } catch { return false; }
  };
  const isDir = async (p: string): Promise<boolean> => {
    try { return (await fsStat(p)).isDirectory(); } catch { return false; }
  };
  return {
    platform: process.platform,
    env: process.env,
    isFile,
    isDir,
    which: (name) => whichInPath(name, process.env, isFile),
    appPathOf: regAppPath,
    applicationRoots: ["/Applications", (process.env.HOME ?? "") + "/Applications"],
  };
}

// ── 解析 map（惰性、每进程一次；点击不重探测——同 dsh availability）──

let cachedMap: Promise<Map<string, ResolvedTarget>> | null = null;

/** 目录表解析入口（每进程首次调用触发；单条失败 = 缺席，不阻塞其它条目） */
export function resolveOpenTargets(probe: TargetProbe = productionProbe()): Promise<Map<string, ResolvedTarget>> {
  cachedMap ??= Promise.all(
    OPEN_TARGET_CATALOG.map((spec) => resolveTarget(spec, probe).catch(() => null)),
  ).then((rows) => {
    const map = new Map<string, ResolvedTarget>();
    for (const r of rows) if (r !== null) map.set(r.id, r);
    return map;
  });
  return cachedMap;
}

/** 测试口：重置进程级缓存 */
export function resetOpenTargetCache(): void {
  cachedMap = null;
}

/** 启动遇 ENOENT 后的重解析（自愈）：该条目重解析一次，证不出移除（dsh refreshResolution 同款） */
export async function refreshTarget(
  id: string,
  probe: TargetProbe = productionProbe(),
): Promise<ResolvedTarget | null> {
  const live = await resolveOpenTargets(probe);
  const spec = OPEN_TARGET_CATALOG.find((s) => s.id === id);
  if (spec === undefined) return null;
  const fresh = await resolveTarget(spec, probe).catch(() => null);
  if (fresh === null) {
    live.delete(id);
    return null;
  }
  live.set(id, fresh);
  return fresh;
}

// ── 启动编排（detached + env 白名单 + 看护窗）──

/** env 白名单（Windows GUI 进程必需集；宿主池凭据零透传——白名单比黑名单剥除稳） */
const ENV_WHITELIST = [
  "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP",
  "LOCALAPPDATA", "PROGRAMDATA", "USERPROFILE", "COMSPEC", "PROGRAMFILES", "APPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "OS", "WINDIR",
] as const;

/** 白名单 env（凭据清洗；生产 = process.env 投影） */
export function scrubbedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** 打开结果二态（NativeOpenOutcome 同形） */
export interface OpenWithOutcome {
  opened?: boolean;
  error?: string;
}

/**
 * 用指定应用打开路径：目标路径追加在 launch.args 尾部（fileArgs 形态除外）。
 * watchMs 看护窗：窗内 spawn error 优先、非零退出才算失败、窗关仍活 =
 * 成功（前台常驻型进程不能等退出）。携 fileArgs 的定位器（explorer 类）
 * 例外走 always 族——委托给已运行桌面进程时退出码恒 1（成功语义），只认
 * spawn error（native-open 对 explorer 的既有裁决同款）。
 */
export async function runOpenWith(
  target: ResolvedTarget,
  absPath: string,
  opts: { watchMs?: number; spawnImpl?: (cmd: string, args: string[], env: Record<string, string>) => ChildProcess; isDir?: boolean } = {},
): Promise<OpenWithOutcome> {
  // windowsHide 禁用（cr-837）：CREATE_NO_WINDOW 沿 stub 转发链继承——Win11
  // System32\notepad.exe 是 Store 版转发 stub、explorer 委托桌面进程，真窗口
  // 一并被藏（opened:true 但无窗口）。GUI 启动器本就无控制台可闪。
  const spawnIt = opts.spawnImpl ?? ((cmd, as, env) => spawn(cmd, as, { detached: true, stdio: "ignore", env }));
  // 文件目标 + explorer 类 fileArgs：定位选中形态（/select, / -R）；否则路径追加尾部
  const argv = opts.isDir !== true && target.launch.fileArgs !== undefined
    ? target.launch.fileArgs(absPath)
    : [...target.launch.args, absPath];
  return watchLaunch(() => spawnIt(target.launch.command, argv, scrubbedEnv()), opts.watchMs ?? 400, target.launch.fileArgs !== undefined);
}

/** 看护窗启动（spawn error 优先；窗内非零退出 = 失败；窗关仍活 = 成功。always 族忽略退出码——explorer 委托桌面进程恒 1） */
function watchLaunch(launch: () => ChildProcess, watchMs: number, always = false): Promise<OpenWithOutcome> {
  return new Promise<OpenWithOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = launch();
    } catch (err) {
      resolve({ error: "启动失败：" + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    let settled = false;
    const done = (outcome: OpenWithOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ opened: true });
    }, watchMs);
    child.on("error", (err: Error) => done({ error: err.message }));
    child.on("close", (code) => {
      if (code === 0 || always) done({ opened: true });
      else done({ error: "应用退出码 " + (code ?? -1) });
    });
  });
}

// ── 应用图标提取（cr-830：win exe 图标 → 16px PNG base64；mac/linux = null
//   回落 lucide 线性图标。cr-833 上提为共享管线 extractExeIconPng：打开方式
//   菜单（exe 主图标）与文件关联图标（DefaultIcon 的 path,index 形态）共用。
//   每 id 提取一次进程内缓存，失败缓存 null）──

const iconCache = new Map<string, string | null>();

/**
 * PowerShell 图标提取（-STA：Shell COM 单元；16px PNG base64 从 stdout 返回）。
 * source 分支：.png 文件直接解码（dsh PngFromIconSource 同款）；存在的
 * exe/ico/dll 按 index 走 SHDefExtractIcon（非零索引/负值资源 ID 精确取，
 * 比 ExtractAssociatedIcon 只取主图标准）；否则 ExtractAssociatedIcon 兜底
 * （exe 被删时从残留注册给占位图标——cr-830 既有行为保留）。
 */
export function extractExeIconPng(exePath: string, index = 0): Promise<string | null> {
  const psExe = exePath.replace(/'/g, "''");
  const nl = String.fromCharCode(10);
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -ReferencedAssemblies System.Drawing @"',
    'using System;',
    'using System.Drawing;',
    'using System.Runtime.InteropServices;',
    'public static class NativeIcons {',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]',
    '  static extern int SHDefExtractIcon(string path, int index, uint flags, out IntPtr large, out IntPtr small, uint size);',
    '  [DllImport("user32.dll")]',
    '  static extern bool DestroyIcon(IntPtr icon);',
    '  public static Icon Extract(string path, int index) {',
    '    IntPtr large = IntPtr.Zero, small = IntPtr.Zero;',
    '    try {',
    '      if (SHDefExtractIcon(path, index, 0, out large, out small, 32) != 0 || large == IntPtr.Zero) return null;',
    '      return Icon.FromHandle(large);',
    '    } finally {',
    '      if (small != IntPtr.Zero) DestroyIcon(small);',
    '    }',
    '  }',
    '}',
    '"@',
    'function Get-SourceIcon([string]$path, [int]$index) {',
    '  $path = [Environment]::ExpandEnvironmentVariables($path)',
    '  if ($path.EndsWith(".png", [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $path)) {',
    '    return [System.Drawing.Image]::FromFile($path)',
    '  }',
    '  if (Test-Path -LiteralPath $path) {',
    '    $native = [NativeIcons]::Extract($path, $index)',
    '    if ($null -ne $native) { return $native.ToBitmap() }',
    '  }',
    '  return [System.Drawing.Icon]::ExtractAssociatedIcon($path).ToBitmap()',
    '}',
    '$src = Get-SourceIcon -path \'' + psExe + '\' -index ' + index,
    'if ($null -eq $src) { exit 1 }',
    // 32→16 缩放提取端一次完成（GDI+ 预乘 alpha 正确）：浏览器非整比缩放
    // 插值路径不受控，32px 原图直发会在边缘混出暗晕（2026-10-31 反馈）。
    // 幽灵环清理：A<24 近透明残影置 0——其 RGB 是插值噪声，任何底色呈脏边。
    '$b = New-Object System.Drawing.Bitmap(16, 16)',
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '$g.DrawImage($src, 0, 0, 16, 16)',
    '$g.Dispose()',
    '$src.Dispose()',
    '$rect = New-Object System.Drawing.Rectangle(0, 0, 16, 16)',
    '$d = $b.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)',
    '$bytes = New-Object byte[] ($d.Stride * 16)',
    '[System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)',
    'for ($k = 3; $k -lt $bytes.Length; $k += 4) { if ($bytes[$k] -lt 24) { $bytes[$k] = 0 } }',
    '[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $d.Scan0, $bytes.Length)',
    '$b.UnlockBits($d)',
    '$ms = New-Object System.IO.MemoryStream',
    '$b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($ms.ToArray())',
  ].join(nl);
  // -EncodedCommand 免命令行解析（路径不过 shell——防注入同 dsh 裁决）
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (c: Buffer) => { buf += c.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const v = buf.trim();
      resolve(code === 0 && v !== '' ? v : null);
    });
  });
}

/**
 * 单目标图标（进程内缓存；win = exe 提取 PNG base64 dataURL，其它平台 = null）。
 */
export async function targetIconOf(target: ResolvedTarget): Promise<string | null> {
  if (iconCache.has(target.id)) return iconCache.get(target.id) ?? null;
  let icon: string | null = null;
  if (process.platform === 'win32' && target.launch.command.toLowerCase().endsWith('.exe')) {
    const b64 = await extractExeIconPng(target.launch.command);
    icon = b64 === null ? null : 'data:image/png;base64,' + b64;
  }
  iconCache.set(target.id, icon);
  return icon;
}
