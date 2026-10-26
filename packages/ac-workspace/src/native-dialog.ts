// ============================================================
// ac-workspace/src/native-dialog.ts —— 本机系统原生文件夹选择
//（纯模块：脚本构造 / 命令矩阵 / 结果分类 / spawn 编排；零 cordis 依赖）
//
// 为什么不走浏览器原生（<input webkitdirectory> / showDirectoryPicker）：
// 浏览器安全模型不暴露所选目录的本机绝对路径，而工作区登记需要真实
// 绝对路径（白名单根）。宿主 Node 与浏览器同机（本地桌面形态），由
// 服务端唤起系统对话框是唯一拿到绝对路径的路径。
//
// 平台矩阵：
//   win32   powershell.exe -EncodedCommand（内嵌 C# interop：IFileDialog +
//           FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM —— Vista+ 现代选择器，
//           地址栏/搜索/收藏夹与资源管理器同款；Add-Type 编译失败或 Pick
//           抛异常时 catch 回退 WinForms FolderBrowserDialog 保功能可用。
//           用户取消 ≠ 异常：Show 返回非 0 → null → __CANCELLED__，不触发
//           回退，杜绝"取消后又弹一个框"）。标题经环境变量传入（Unicode
//           天然无乱码），脚本体恒 ASCII；stdout 强制 UTF-8（中文路径
//           回传不损坏）。
//   darwin  osascript choose folder（POSIX path 输出）。
//   linux   zenity --file-selection --directory → kdialog --getexistingdirectory
//           （候选链：前者 ENOENT 才试后者）。
// 输出协议：win32 = 单行路径或 __CANCELLED__；其余按退出码（1 = 取消，
// osascript 另认 stderr 取消关键词——错误文案本地化时的防御）。
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';

/** 原生选择结果三态：path（选定）/ cancelled（用户取消）/ error（不可用——前端降级回应用内浏览） */
export interface NativePickOutcome {
  /** 选定文件夹的本机绝对路径 */
  path?: string;
  /** 用户取消（非错误——前端静默收场） */
  cancelled?: boolean;
  /** 平台无选择器 / 启动失败 / 执行异常（前端降级回 browseDirs 应用内浏览） */
  error?: string;
}

/** 命令协议族：决定 stdout / 退出码的分类方式 */
export type PickFamily = 'line' | 'osascript' | 'zenity' | 'kdialog';

/** 一条候选命令（ENOENT 时试下一条；win32 走 -EncodedCommand 单 argv 免引号地狱） */
export interface PickCommand {
  cmd: string;
  args: string[];
  family: PickFamily;
  /** 追加环境变量（合并于 process.env 之上——win32 标题通道） */
  env?: Record<string, string>;
}

/** 等待用户在系统对话框完成操作的上限（与服务端兜底、前端 RPC 超时三处对齐：10 分钟） */
const DEFAULT_PICK_TIMEOUT_MS = 10 * 60_000;

/** win32 单行输出协议的取消标记 */
const CANCEL_MARKER = '__CANCELLED__';

/** 标题环境变量（win32——Unicode 直达，不经 argv/脚本文本转码） */
const TITLE_ENV = 'AGENTCHAT_PICK_TITLE';

// ---- Windows PowerShell 脚本（体恒 ASCII；标题走环境变量）----
// 注意：以 JS 模板字面量承载，PS 变量引用（$x / $env:）不得出现 "${" 序列。
const WINDOWS_PICK_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$t = $env:AGENTCHAT_PICK_TITLE
$src = @'
using System;
using System.Runtime.InteropServices;

public static class NativeFolderPick
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    // Thread DPI awareness, best first (DSH same cascade): per-monitor-v2 (-4,
    // Win10 1703+), per-monitor (-3, 1607+), system-aware (-2). Without it the
    // dialog is rendered at 96 DPI and bitmap-stretched on scaled displays
    // (e.g. 150%), which reads as blurry text. Returns old context, or Zero
    // when the host rejects the value: cascade down; best-effort only.
    private static void EnableThreadDpiAwareness()
    {
        try
        {
            IntPtr[] contexts = { new IntPtr(-4), new IntPtr(-3), new IntPtr(-2) };
            foreach (IntPtr c in contexts)
            {
                if (SetThreadDpiAwarenessContext(c) != IntPtr.Zero) return;
            }
        }
        catch { /* pre-1607 host: cosmetic best-effort, dialog still works */ }
    }

    // Foreground activation (DSH-proven trick): Windows denies foreground to
    // a dialog spawned by a background host process, so the picker would hide
    // behind the browser. A synthesized Alt tap right before Show lifts the
    // lock and lets the dialog activate as the foreground window.
    private static void ForegroundTap()
    {
        const byte VK_MENU = 0x12;
        const uint KEYEVENTF_KEYUP = 0x2;
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogCom { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        // vtable slots declared in strict SDK header order (ShObjIdl_core.h),
        // up to the ones we use. IUnknown's 3 slots are implicit; Show is the
        // only member of IModalWindow. Slot order matters: misalignment maps
        // GetOptions onto Unadvise etc. and returns E_INVALIDARG.
        [PreserveSig] int Show(IntPtr hwndOwner);
        [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        [PreserveSig] int SetFileTypeIndex(uint iFileType);
        [PreserveSig] int GetFileTypeIndex(out uint piFileType);
        [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
        [PreserveSig] int Unadvise(uint dwCookie);
        [PreserveSig] int SetOptions(uint fos);
        [PreserveSig] int GetOptions(out uint pfos);
        [PreserveSig] int SetDefaultFolder(IntPtr psi);
        [PreserveSig] int SetFolder(IntPtr psi);
        [PreserveSig] int GetFolder(out IntPtr ppsi);
        [PreserveSig] int GetCurrentSelection(out IntPtr ppsi);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        [PreserveSig] int GetResult(out IShellItem ppsi);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        // vtable order per ShObjIdl_core.h; GetDisplayName (slot 5) with
        // SIGDN_FILESYSPATH yields the item's full file-system path
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    public static string Pick(string title)
    {
        EnableThreadDpiAwareness(); // before any window on this thread (blurry-text fix)
        IFileDialog dlg = (IFileDialog)(object)new FileOpenDialogCom();
        uint opts;
        dlg.GetOptions(out opts);
        dlg.SetOptions(opts | 0x20u | 0x1000u); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        dlg.SetTitle(title);
        ForegroundTap();
        if (dlg.Show(GetForegroundWindow()) != 0) return null; // user cancelled
        // Full path via GetResult -> GetDisplayName(SIGDN_FILESYSPATH). GetFileName
        // only reads the "File name" edit box, which does not carry the full path
        // in folder-picking mode (DSH's worker uses this same GetResult route).
        IShellItem item;
        if (dlg.GetResult(out item) != 0) return null;
        string path;
        if (item.GetDisplayName(0x80058000u, out path) != 0) return null; // SIGDN_FILESYSPATH
        return path;
    }
}
'@
# 现代路径异常（Add-Type 编译失败 / Pick 抛错）→ 回退 FolderBrowserDialog 保功能；
# 用户取消（Show 非 0 → null，非异常）不进回退——杜绝"取消后又弹一个框"
$picked = $null
$failed = $false
try {
  Add-Type -TypeDefinition $src -Language CSharp
  $picked = [NativeFolderPick]::Pick($t)
} catch {
  $picked = $null
  $failed = $true
}
if ($failed) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    $fb.Description = $t
    $fb.ShowNewFolderButton = $false
    if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $fb.SelectedPath }
  } catch { $picked = $null }
}
if ($null -eq $picked) { [Console]::Out.Write('__CANCELLED__') } else { [Console]::Out.Write($picked) }
`.trimStart();

/** AppleScript 字符串字面量（先转义反斜杠再转义双引号） */
function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 平台 → 候选命令链（纯函数；空数组 = 平台不支持）。
 * win32 用 -EncodedCommand（base64(UTF-16LE)）传脚本：单 argv、无引号/
 * 转义歧义、不受 stdin 语义差异影响。
 */
export function pickFolderCommands(platform: NodeJS.Platform, title: string | undefined): PickCommand[] {
  const t = title ?? '';
  if (platform === 'win32') {
    return [{
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
        Buffer.from(WINDOWS_PICK_SCRIPT, 'utf16le').toString('base64')],
      family: 'line',
      env: { [TITLE_ENV]: t },
    }];
  }
  if (platform === 'darwin') {
    return [{
      cmd: 'osascript',
      args: ['-e', `POSIX path of (choose folder${t ? ` with prompt ${appleScriptString(t)}` : ''})`],
      family: 'osascript',
    }];
  }
  if (platform === 'linux') {
    return [
      { cmd: 'zenity', args: ['--file-selection', '--directory', ...(t ? ['--title', t] : [])], family: 'zenity' },
      { cmd: 'kdialog', args: ['--getexistingdirectory', '.', ...(t ? ['--title', t] : [])], family: 'kdialog' },
    ];
  }
  return [];
}

/**
 * 命令输出分类（纯函数）：
 *   line     退出 0 → 单行 = 路径 / __CANCELLED__ = 取消；非 0 → error
 *   osascript 退出 0 → 路径；非 0 且 stderr 含取消词 → 取消
 *   zenity/kdialog 退出 0 → 路径；退出 1 → 取消（zenity/kdialog 的取消码）
 */
export function classifyPickOutcome(family: PickFamily, code: number, stdout: string, stderr: string): NativePickOutcome {
  const out = stdout.trim();
  if (family === 'line') {
    if (code === 0) {
      if (!out || out === CANCEL_MARKER) return { cancelled: true };
      return { path: out };
    }
    return { error: stderr.trim() || `选择器进程退出码 ${code}` };
  }
  if (code === 0) return out ? { path: out } : { cancelled: true };
  if (family === 'osascript' && /cancel|取消/i.test(stderr)) return { cancelled: true };
  if ((family === 'zenity' || family === 'kdialog') && code === 1) return { cancelled: true };
  return { error: stderr.trim() || `选择器进程退出码 ${code}` };
}

/** 单条命令执行结果：outcome = 已定论；next = 命令不存在（ENOENT）→ 试下一候选 */
type RunOneResult = { kind: 'outcome'; outcome: NativePickOutcome } | { kind: 'next' };

function runOne(command: PickCommand, timeoutMs: number): Promise<RunOneResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.cmd, command.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: command.env ? { ...process.env, ...command.env } : process.env,
      });
    } catch {
      resolve({ kind: 'next' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ kind: 'outcome', outcome: { error: `系统选择框等待超时（${Math.round(timeoutMs / 60000)} 分钟未完成选择）` } });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => { stderr += d; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') resolve({ kind: 'next' });
      else resolve({ kind: 'outcome', outcome: { error: `选择器启动失败：${err.message}` } });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: 'outcome', outcome: classifyPickOutcome(command.family, code ?? -1, stdout, stderr) });
    });
  });
}

/**
 * 唤起本机系统文件夹选择对话框（阻塞至用户完成/取消/超时）。
 * commands 可注入（测试用真进程替换对话框命令）；缺省按平台推导。
 */
export async function runNativePickFolder(opts: {
  title?: string;
  timeoutMs?: number;
  commands?: PickCommand[];
  platform?: NodeJS.Platform;
} = {}): Promise<NativePickOutcome> {
  const commands = opts.commands ?? pickFolderCommands(opts.platform ?? process.platform, opts.title);
  if (commands.length === 0) {
    return { error: '当前平台无原生文件夹选择器（支持 Windows / macOS / Linux 桌面）' };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PICK_TIMEOUT_MS;
  for (const command of commands) {
    const r = await runOne(command, timeoutMs);
    if (r.kind === 'outcome') return r.outcome;
    // ENOENT → 试下一候选（linux 的 zenity → kdialog 链）
  }
  return { error: `未找到可用的原生选择器命令（${commands.map((c) => c.cmd).join(' / ')}）` };
}
