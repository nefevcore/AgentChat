// ============================================================
// ac-shell-tools/src/shell.ts —— shell 探测（src shell 原样平移）
//
// Windows 优先 PowerShell 7 (pwsh)，未安装回退 Windows PowerShell
// (powershell.exe)，再回退 cmd。探测结果一次性缓存。
// ============================================================
import { spawnSync } from 'node:child_process';

export interface ShellConfig {
  shell: string;
  args: string[];
}

/** Windows shell 配置（pwsh 探测结果一次性缓存） */
let winShell: ShellConfig | null = null;

export function getShellConfig(): ShellConfig {
  if (process.platform !== 'win32') {
    return { shell: '/bin/bash', args: ['-c'] };
  }
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
    winShell = { shell: 'pwsh', args: ['-NoProfile', '-Command'] };
  } else if (probe('powershell.exe', ['-NoProfile', '-Command', '$true'])) {
    winShell = { shell: 'powershell.exe', args: ['-NoProfile', '-Command'] };
  } else {
    // 最后回退 cmd（Windows 必有）
    winShell = { shell: 'cmd', args: ['/d', '/s', '/c'] };
  }
  return winShell;
}
