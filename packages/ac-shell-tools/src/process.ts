// ============================================================
// ac-shell-tools/src/process.ts —— 进程原语与输出裁剪（src shell 平移）
// ============================================================
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';

/** ANSI 转义序列清理（颜色/光标移动等 CSI 与 OSC 序列）——bash 输出归一：
 *  vitest/pwsh 等子进程的彩色输出进了返回结果，会在 WebUI/日志里渲染成
 *  乱码（\u001b[31m…\u001b[39m 一类）。工具结果面向纯文本消费方，统一剥掉。
 *  模式对齐 ansi-regex：① CSI（ESC + [ 及参数 + 终符）；② OSC（ESC ] …
 *  ST/BEL 收尾，窗口标题一类）；③ 杂散 ESC 单字符兜底。 */
const ANSI_PATTERN =
  /[\u001b\u009b][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])|\u001b\][^\u001b]*(?:\u001b\\|\u0007)?|\u001b/g;

export function stripAnsi(text: string): string {
  return text ? text.replace(ANSI_PATTERN, '') : text;
}

/** 进程是否存活（kill(pid, 0)：无异常 = 存活；EPERM = 存在但无权限；ESRCH = 不存在） */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
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

/** 读取日志文件尾部 N 行（bash 后台任务的 log_file；不存在返回空）——ANSI 清理 */
export function tailLogFile(file: string, lines: number): string {
  if (!file || !fs.existsSync(file)) return '';
  return stripAnsi(
    fs
      .readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-lines)
      .join('\n'),
  );
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

/** 命令不存在形态（本地化变体表）：错误归因与 invocation-error 判定共用一份口径 */
const MISSING_COMMAND_RE = /command not found|is not recognized|不是内部或外部命令|无法将.*识别为|不会被识别为/;

/** 根据错误输出生成引导性修复说明（尽力而为；无明确归因时返回空串）——输入先清 ANSI 防彩色输出干扰模式匹配 */
export function buildErrorMessage(command: string, output: string, exitCode: number | null): string {
  const out = stripAnsi(output || '');
  const low = out.toLowerCase();

  if (MISSING_COMMAND_RE.test(low)) {
    const missing = extractMissingCommand(out, command);
    if (missing.toLowerCase() === 'utf8') {
      return 'PowerShell 中请使用 [System.Text.Encoding]::UTF8（不是裸 UTF8），例如：[Console]::OutputEncoding = [System.Text.Encoding]::UTF8。';
    }
    if (missing === '' && /[;&|]/.test(command)) {
      return 'PowerShell 报告命令未找到，但命令是管道/组合形态——缺失的可能是其中某一段而非首个命令。建议：拆成单条命令逐段执行定位缺失段；若段内有正则或含 | 的参数（如 -Pattern），需给参数加引号（-Pattern "a|b"）。';
    }
    // cr-1227/ISSUE-18 建议③：点名准确之后仍缺「为什么」——命令含管道/组合符时，
    // 缺失段通常不是笔误而是 `|` 被 shell 解析成管道（`-Pattern a|b` 一段变两条命令）。
    // 不提这句，用户看到「找不到命令 待办」还得自己倒推病因。
    const pipeHint = /[;&|]/.test(command)
      ? '——该命令含 | / ; / & 组合符：缺失段很可能是被管道切断的一段（如 -Pattern a|b 未加引号）或组合命令中失败的那段；给含 | 的参数加引号，或拆成单条命令逐段执行。'
      : '';
    return `PowerShell 找不到命令“${missing || '该命令'}”。可先用 Get-Command ${missing || '<名称>'} 确认命令是否安装，或改用 read/glob/grep 等工具完成同类任务${pipeHint}`;
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

/**
 * 判定失败输出是否为「命令未跑起来/语法层失败」（invocation-error）：
 * PowerShell ParserError / command not found 形态 / 终端语法拒绝。
 * 其余非零退出（测试红灯、断言失败、grep 无命中）= command-feedback
 * ——命令语义输出，不是工具链路错误（2026-09-21 画像 Ⓐ）。
 */
export function looksLikeInvocationError(cleanOutput: string): boolean {
  const low = cleanOutput.toLowerCase();
  if (/parsererror|incompleteinput|missingclosing|unexpectedtoken/.test(low)) return true;
  // 命令不存在形态：MISSING_COMMAND_RE 单源（变体表含中文 PS 实测形态
  // "术语 'x' 不会被识别为"——2026-09-21 画像 Ⓐ）
  if (MISSING_COMMAND_RE.test(low)) return true;
  if (/terminator.*missing|missing.*terminator/.test(low)) return true;
  return false;
}

function extractMissingCommand(output: string, command: string): string {
  const patterns = [
    /无法将["“']?([^"“'”]+?)["”']?项识别为/,
    // PS 7.7 zh-CN 形态「术语 'x' 不会被识别为…」（cr-1223/ISSUE-18：缺此
    // 模式时落回兜底取命令首词——Get-Content | 中文词 断管后错报 Get-Content）
    /术语\s+["“']?([^"“'”\s]+?)["”']?\s*不会被识别为/,
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
  // 兜底护栏（cr-1223/ISSUE-18）：命令含管道/分号/`&` 组合时，报错缺的
  // 可能是其中任一段——取首词归因会点名一个存在的命令（真缺的是裸 `|`
  // 后的中文词段），不猜名，改说组合命令某段失败。
  if (/[;&|]/.test(command)) return '';
  const first = command.match(/\b([a-z][a-z0-9_-]*)\b/i);
  return first ? first[1] : '';
}
