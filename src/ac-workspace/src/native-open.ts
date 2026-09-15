// ============================================================
// ac-workspace/src/native-open.ts —— 用系统默认程序打开文件/所在文件夹
//（纯模块：命令矩阵 / spawn 编排 / 输出分类；零 cordis 依赖——与
// native-dialog.ts 同族形态，行为面由单测全量锁定）
//
// 语义：path 为文件 → 系统默认程序打开（VS Code 里点「用桌面应用打开」
// 同款体验）；select=true → 只在文件管理器里定位（win 资源管理器选中
// 高亮 / Finder reveal / linux 尚无通用选中协议——退化为打开所在目录）。
//
// 平台矩阵（与 open 系工具同一套系统命令词汇）：
//   win32   cmd /c start "" <path>（ShellExecute——直 CreateProcess
//           explorer 的窗口在 Win11 可能永不显示，2026-09-14 排查；
//           选中：explorer.exe /select,<path>）。
//   darwin  open <path>（选中：open -R <path>——Finder reveal）
//   linux   xdg-open <path>（父目录定位 = xdg-open <dir>）。无选中
//           协议：桌面环境各异（dolphin --select / nautilus -s），
//           不猜测——统一退化打开所在目录，文档注明。
//
// 结果三态（NativePickOutcome 同形：opened / error；无 cancelled——
// 打开无用户交互面）。退出码协议：win32 explorer 恒 0/1 不可靠
//（正常打开也可能非 0）——只认 spawn error（ENOENT/启动失败）；
// darwin/linux open/xdg-open 退出 0 = 成功，非 0 = error。
// ============================================================
import { spawn, type ChildProcess } from 'node:child_process';

/** 打开结果二态：opened（已派发）/ error（命令缺失或启动失败） */
export interface NativeOpenOutcome {
  /** 已交由系统默认程序处理 */
  opened?: boolean;
  /** 平台无命令 / 启动失败 / 非零退出（open 系） */
  error?: string;
}

/** 打开命令（单条；无候选链——三平台各一条系统命令，ENOENT 即 error） */
export interface OpenCommand {
  cmd: string;
  args: string[];
}

/** win32 / darwin / linux 之外的退出码语义（explorer 退出码不可靠） */
export type OpenFamily = 'always' | 'strict';

/** 平台 → 打开命令（纯函数；null = 平台不支持） */
export function openCommands(
  platform: NodeJS.Platform,
  target: string,
  opts: { select?: boolean } = {},
): { command: OpenCommand; family: OpenFamily } | null {
  if (platform === 'win32') {
    // 经 cmd start（ShellExecute）而非直呼 explorer.exe：Win11 直接
    // CreateProcess explorer 产的 CabinetWClass 窗口可能永不显示
    //（实测 vis=False 的隐藏窗口池，2026-09-14 排查）；ShellExecute
    // 走 shell 集成路径稳定前台弹窗。start 后首个空串参数 = 标题占位
    //（防带空格路径被当窗口标题解析）。select 用 explorer /select 选中
    // 形态（cmd start 不支持选中参数——explorer 直接子命令）
    return {
      command: opts.select
        ? { cmd: 'explorer.exe', args: ['/select,', target] }
        : { cmd: 'cmd.exe', args: ['/c', 'start', '', target] },
      family: 'always',
    };
  }
  if (platform === 'darwin') {
    return {
      command: { cmd: 'open', args: opts.select ? ['-R', target] : [target] },
      family: 'strict',
    };
  }
  if (platform === 'linux') {
    // 无通用选中协议：select 退化为打开父目录
    return { command: { cmd: 'xdg-open', args: [opts.select ? parentDirOf(target) : target] }, family: 'strict' };
  }
  return null;
}

/** 父目录（纯词法切分；locateReadable 产出的绝对路径不含尾分隔符） */
export function parentDirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

/**
 * 派发系统打开（不等待应用生命周期——spawn 成功派发即视为打开）。
 * timeoutMs 仅防僵（explorer 常驻不退出——always 族不等退出码，
 * spawn 后 delay 即认 opened；strict 族等退出码但超时按打开计：
 * 慢速桌面文件管理器晚起不该误报失败）。
 */
export async function runNativeOpen(
  target: string,
  opts: { select?: boolean; platform?: NodeJS.Platform; timeoutMs?: number; command?: { command: OpenCommand; family: OpenFamily } } = {},
): Promise<NativeOpenOutcome> {
  const built = opts.command ?? openCommands(opts.platform ?? process.platform, target, opts);
  if (!built) {
    return { error: '当前平台不支持本地打开（支持 Windows / macOS / Linux 桌面）' };
  }
  const { command, family } = built;
  return new Promise<NativeOpenOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.cmd, command.args, {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
    } catch (err) {
      resolve({ error: `打开命令启动失败：${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // 派发即认可（detached + ignore stdio：不随宿主退出，不阻塞事件循环）
    const ack = (): void => resolve({ opened: true });
    if (family === 'always') {
      // explorer 常驻不退出：短确认窗内 spawn error（ENOENT 等）优先，
      // 窗口平安度过即认可打开（退出码不可靠不参与判定）
      let settled = false;
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ error: `打开命令启动失败：${err instanceof Error ? err.message : String(err)}` });
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        ack();
      }, 150);
      return;
    }
    const timer = setTimeout(() => { child.unref(); ack(); }, opts.timeoutMs ?? 5000);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') resolve({ error: `未找到打开命令：${command.cmd}` });
      else resolve({ error: `打开命令启动失败：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ opened: true });
      else resolve({ error: `打开命令退出码 ${code ?? -1}（${command.cmd}）` });
    });
  });
}
