// ============================================================
// ac-shell-tools/src/shells.ts —— shell 平台谱系定义
//
// 工具拆分（2026-09-16）：单平台工具行（pwsh / bash）各自的 shell
// 声明。每行工具在自己平台下注册，本模块回答「这个平台上用哪个
// 可执行体、命令怎么预处理」：
//   · pwsh（Windows）：探测 pwsh → powershell.exe（cmd 回退不注册
//     工具行——不完整方言不入谱系）；命令过 Unix→PS 翻译（fail-
//     closed）+ UTF-8 输出编码前缀。
//   · bash（Unix）：/bin/bash -c 纯透传，零预处理。
// 探测结果一次性缓存（沿用旧 shell.ts 行为）。
// ============================================================
import { spawnSync } from 'node:child_process';
import { translateUnixToPowerShell } from './unix-translate.ts';

export interface ShellSpec {
  /** 可执行体（spawn 第一参） */
  shell: string;
  /** spawn 参数前缀（命令作为最后一位拼接） */
  args: string[];
  /** 供 job kind / 诊断展示的家族名（'pwsh' | 'bash'） */
  family: 'pwsh' | 'bash';
}

/**
 * 命令预处理产物：实际执行串 +（如有）翻译痕迹。
 * translatedCommand 非空 = 原命令与执行串有语义距离，失败时需对齐归因。
 */
export interface PreparedCommand {
  commandToRun: string;
  translatedCommand?: string;
}

/** pwsh：Unix→PS 翻译（fail-closed：不认识的形状原样透传）+ UTF-8 前缀 */
export function preparePwsh(command: string): PreparedCommand {
  let commandToRun = command;
  let translatedCommand: string | undefined;
  const translated = translateUnixToPowerShell(command);
  if (translated.translated) {
    commandToRun = translated.command;
    translatedCommand = translated.command;
  }
  // 强制 UTF-8 输出编码（消除中文 GBK 乱码）
  return { commandToRun: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${commandToRun}`, translatedCommand };
}

/** bash：纯透传（Unix 原生方言，零预处理） */
export function prepareBash(command: string): PreparedCommand {
  return { commandToRun: command };
}

/** Windows PowerShell 系探测（pwsh 优先，powershell.exe 回退；一次性缓存） */
let winShell: ShellSpec | null = null;

export function pwshSpec(): ShellSpec | null {
  if (process.platform !== 'win32') return null;
  if (winShell) return winShell;
  const probe = (shell: string, args: string[]): boolean => {
    try {
      const r = spawnSync(shell, args, { timeout: 3000, stdio: 'ignore', windowsHide: true });
      return r.error == null && r.status === 0;
    } catch {
      return false;
    }
  };
  // PowerShell 7 (pwsh)：引号/参数传递显著优于 Windows PowerShell 5.1
  if (probe('pwsh', ['-NoProfile', '-Command', '$true'])) {
    winShell = { shell: 'pwsh', args: ['-NoProfile', '-Command'], family: 'pwsh' };
  } else if (probe('powershell.exe', ['-NoProfile', '-Command', '$true'])) {
    winShell = { shell: 'powershell.exe', args: ['-NoProfile', '-Command'], family: 'pwsh' };
  } else {
    winShell = null; // cmd 回退：不完整方言（无 PS 语法），不入工具谱系
  }
  return winShell;
}

/** bash 规格（Unix 专属；Windows 无 /bin/bash 时 null） */
export function bashSpec(): ShellSpec | null {
  if (process.platform === 'win32') return null;
  return { shell: '/bin/bash', args: ['-c'], family: 'bash' };
}
