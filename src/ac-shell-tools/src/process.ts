// ============================================================
// ac-shell-tools/src/process.ts —— 进程原语与输出裁剪（src shell 平移）
// ============================================================
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';

/** 进程是否存活（kill(pid, 0)：无异常 = 存活；EPERM = 存在但无权限；ESRCH = 不存在） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** 杀整个进程树（Windows: taskkill /F /T；Unix: 负 PID kill 进程组） */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* taskkill 本身失败忽略 */
    }
  } else {
    // 负 PID = 进程组：spawn 需 detached:true 使子进程成为组长（前台/
    // 后台两处均已设置）。组长身份缺失（历史进程/异常形态）→ ESRCH，
    // 回退单杀本进程，至少不让调用方悬挂。
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 进程可能已退出 */
      }
    }
  }
}

/** 读取日志文件尾部 N 行（bash 后台任务的 log_file；不存在返回空） */
export function tailLogFile(file: string, lines: number): string {
  if (!file || !fs.existsSync(file)) return '';
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

/** 从中间裁剪超长输出，保留开头和结尾（默认开头约 45%，结尾约 55%） */
export function truncateMiddle(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (!text || text.length <= maxLen) return { text, truncated: false };
  const marker = `\n... [输出已截断：中间省略 ${text.length - maxLen} 字符；完整输出 ${text.length} 字符] ...\n`;
  const markerLen = marker.length;
  const headBudget = Math.max(1, Math.floor((maxLen - markerLen) * 0.45));
  const tailBudget = Math.max(1, maxLen - markerLen - headBudget);
  let head = text.slice(0, headBudget);
  const headCut = head.lastIndexOf('\n');
  if (headCut >= Math.floor(headBudget * 0.5)) head = head.slice(0, headCut);
  let tail = text.slice(text.length - tailBudget);
  const tailCut = tail.indexOf('\n');
  if (tailCut >= 0 && tailCut <= Math.floor(tailBudget * 0.5)) tail = tail.slice(tailCut + 1);
  return { text: head + marker + tail, truncated: true };
}

/** 根据错误输出生成引导性修复说明（尽力而为；无明确归因时返回空串） */
export function buildErrorMessage(command: string, output: string, exitCode: number | null): string {
  const out = output || '';
  const low = out.toLowerCase();

  if (/command not found|is not recognized|不是内部或外部命令|无法将.*识别为/.test(low)) {
    const missing = extractMissingCommand(out, command);
    if (missing.toLowerCase() === 'utf8') {
      return 'PowerShell 中请使用 [System.Text.Encoding]::UTF8（不是裸 UTF8），例如：[Console]::OutputEncoding = [System.Text.Encoding]::UTF8。';
    }
    return `PowerShell 找不到命令“${missing || '该命令'}”。可先用 Get-Command ${missing || '<名称>'} 确认命令是否安装，或改用 read/glob/grep 等工具完成同类任务。`;
  }

  if (/unicodeencodeerror|'gbk' codec can't encode|gbk.*encode/.test(low)) {
    return 'Python 输出编码错误。工具已自动注入 PYTHONIOENCODING=utf-8 / PYTHONUTF8=1；若仍出现，请在脚本开头显式执行 sys.stdout.reconfigure(encoding="utf-8")。';
  }

  if (/syntaxerror|unexpected token/.test(low) && /python -c/.test(command)) {
    return 'python -c 内嵌引号在 PowerShell 中容易转义出错；建议把 Python 代码写入临时 .py 文件，再用 python 文件路径 执行。';
  }

  if (!out.trim() && exitCode !== 0 && /[;&|]/.test(command)) {
    return `命令整体退出码为 ${exitCode}，但没有产生输出，说明组合命令中某一段失败。建议拆成多条命令逐段执行以定位失败段。`;
  }

  return '';
}

function extractMissingCommand(output: string, command: string): string {
  const patterns = [
    /无法将["“']?([^"“'”]+?)["”']?项识别为/,
    /'([^']+)' 不是内部或外部命令/,
    /'([^']+)' is not recognized/,
    /([a-zA-Z_][a-zA-Z0-9_-]*): command not found/,
    /command not found: ([a-zA-Z_][a-zA-Z0-9_-]*)/,
    /([a-zA-Z_][a-zA-Z0-9_-]*) : 无法将/,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return m[1].trim();
  }
  const first = command.match(/\b([a-z][a-z0-9_-]*)\b/i);
  return first ? first[1] : '';
}
