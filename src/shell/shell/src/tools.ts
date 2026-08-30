// ============================================================
// @agentchat/shell —— 命令执行工具（bash）
// 迁移自 tools/files.ts（bash 部分）；领域独立，可脱离 AgentChat 复用。
// ============================================================
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { defineTool, resolveSafePath, workspaceRoot, getAllowedPaths, sandboxWorkdir, NS_TOOL_BASH, type ConfigField } from '@agentchat/toolkit';
import { getNamespaceConfig, CAPABILITY_BASE } from '@agentchat/agent-config';
import type { AgentConfig } from '@agentchat/agent-config';
import type { Tool } from '@agentchat/agent-loop';
import type { JobService } from '@agentchat/jobs';
import { killProcessTree, makeJobTool } from './job';

export const BASH_CONFIG_SCHEMA: ConfigField[] = [
  { name: 'defaultTimeout', label: '默认超时', description: '命令默认超时（秒）', type: 'number', default: 30000 },
  { name: 'maxTimeout', label: '最大超时', description: '命令允许的最大超时（秒）', type: 'number', default: 120000 },
  { name: 'outputMaxLen', label: '输出截断', description: '命令输出最大保留字符数', type: 'number', default: 50000 },
  { name: 'maxBuffer', label: '缓冲区上限', description: '命令输出缓冲区上限（字节）', type: 'number', default: 10485760 },
];

// ============================================================
// bash 底层执行器 —— Windows 优先 PowerShell 7 (pwsh)，
// 未安装回退 Windows PowerShell (powershell.exe)，再回退 cmd。
// 照搬旧 bash-process.ts 的 shell 探测 + 进程树杀 + UTF-8 编码。
// ============================================================

interface ShellConfig { shell: string; args: string[]; }

/** Windows shell 配置（pwsh 探测结果一次性缓存） */
let winShell: ShellConfig | null = null;

function getShellConfig(): ShellConfig {
  if (process.platform !== 'win32') {
    return { shell: '/bin/bash', args: ['-c'] };
  }
  if (winShell) return winShell;
  const probe = (shell: string, args: string[]): boolean => {
    try {
      const r = spawnSync(shell, args, { timeout: 3000, stdio: 'ignore', windowsHide: true });
      return r.error == null && r.status === 0;
    } catch { return false; }
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

// ============================================================
// Unix → PowerShell 翻译与输出裁剪
// ============================================================

interface CommandPart { text: string; sep?: string; }

/** 按顶层分隔符拆分命令，忽略引号内的 ; | && 等内容 */
function splitTopLevel(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let cur = '';
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '`') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '`') { escaped = true; cur += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push({ text: cur, sep: two });
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      parts.push({ text: cur, sep: ch });
      cur = '';
      continue;
    }
    if (ch === '\r') {
      if (command[i + 1] === '\n') {
        parts.push({ text: cur, sep: '\r\n' });
        cur = '';
        i++;
      } else {
        parts.push({ text: cur, sep: '\r' });
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur || parts.length === 0) parts.push({ text: cur });
  return parts;
}

/** 按空白拆分参数，保留引号；引号内的空白不会拆分 */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '`') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '`') { escaped = true; cur += ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { args.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 翻译单个命令段；返回 null 表示无需/无法翻译 */
function translateSegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const first = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)/);
  if (!first) return null;
  const cmd = first[1].toLowerCase();
  const rest = trimmed.slice(first[0].length).trim();

  switch (cmd) {
    case 'head': {
      let m = rest.match(/^-n\s+(\d+)\s+(.+)$/i);
      if (m) return `Get-Content ${m[2]} -TotalCount ${m[1]}`;
      m = rest.match(/^-(\d+)\s+(.+)$/);
      if (m) return `Get-Content ${m[2]} -TotalCount ${m[1]}`;
      m = rest.match(/^-n\s+(\d+)$/i);
      if (m) return `Select-Object -First ${m[1]}`;
      m = rest.match(/^-(\d+)$/);
      if (m) return `Select-Object -First ${m[1]}`;
      if (rest && !rest.startsWith('-')) return `Get-Content ${rest} -TotalCount 10`;
      return `Select-Object -First 10`;
    }
    case 'tail': {
      let m = rest.match(/^-n\s+(\d+)\s+(.+)$/i);
      if (m) return `Get-Content ${m[2]} -Tail ${m[1]}`;
      m = rest.match(/^-(\d+)\s+(.+)$/);
      if (m) return `Get-Content ${m[2]} -Tail ${m[1]}`;
      m = rest.match(/^-n\s+(\d+)$/i);
      if (m) return `Select-Object -Last ${m[1]}`;
      m = rest.match(/^-(\d+)$/);
      if (m) return `Select-Object -Last ${m[1]}`;
      if (rest && !rest.startsWith('-')) return `Get-Content ${rest} -Tail 10`;
      return `Select-Object -Last 10`;
    }
    case 'cat': {
      if (!rest) return null;
      return `Get-Content ${rest}`;
    }
    case 'grep': {
      const args = splitArgs(rest);
      let i = 0;
      const flags = new Set<string>();
      let pattern = '';
      const files: string[] = [];
      for (; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
          for (const f of a.slice(1)) flags.add(f);
        } else {
          pattern = a;
          i++;
          break;
        }
      }
      for (; i < args.length; i++) files.push(args[i]);
      if (!pattern) return null;
      const patternQ = psSingleQuote(unquote(pattern));
      const caseArg = flags.has('i') ? '-CaseSensitive:$false' : '-CaseSensitive';
      const lineOut = flags.has('n')
        ? ' | ForEach-Object { if ($_.LineNumber) { "$($_.LineNumber):$($_.Line)" } else { $_.Line } }'
        : ' | ForEach-Object { $_.Line }';
      if (files.length > 0 && flags.has('r')) {
        const paths = files.map(f => psSingleQuote(unquote(f))).join(',');
        return `Get-ChildItem -Path ${paths} -Recurse -File | Select-String -Pattern ${patternQ} ${caseArg}${lineOut}`;
      }
      if (files.length > 0) {
        const paths = files.map(f => psSingleQuote(unquote(f))).join(',');
        return `Select-String -Path ${paths} -Pattern ${patternQ} ${caseArg}${lineOut}`;
      }
      if (flags.has('r')) {
        return `Get-ChildItem -Recurse -File | Select-String -Pattern ${patternQ} ${caseArg}${lineOut}`;
      }
      return `Select-String -Pattern ${patternQ} ${caseArg}${lineOut}`;
    }
    case 'wc': {
      const args = splitArgs(rest);
      const files = args.filter(a => !a.startsWith('-'));
      const flags = args.filter(a => a.startsWith('-')).join('').replace(/-/g, '');
      const fileList = files.map(f => psSingleQuote(unquote(f))).join(',');
      const src = fileList ? `Get-Content ${fileList}` : '';
      if (flags.includes('l')) {
        if (!src) return `Measure-Object -Line | Select-Object -ExpandProperty Lines`;
        return `(${src} | Measure-Object -Line).Lines`;
      }
      if (flags.includes('c')) {
        if (files.length === 1) return `(Get-Item ${fileList}).Length`;
        if (!src) return `Measure-Object -Character | Select-Object -ExpandProperty Characters`;
        return `(${src} | Measure-Object -Character).Characters`;
      }
      if (flags.includes('w')) {
        if (!src) return `Measure-Object -Word | Select-Object -ExpandProperty Words`;
        return `(${src} | Measure-Object -Word).Words`;
      }
      if (fileList) return `(${src} | Measure-Object -Line -Word -Character) | Format-List`;
      return `Measure-Object -Line -Word -Character`;
    }
    case 'find': {
      const args = splitArgs(rest);
      let path = '.';
      let name: string | undefined;
      let maxDepth: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (i === 0 && !a.startsWith('-')) path = unquote(a);
        else if (a === '-name' && args[i + 1]) { name = unquote(args[i + 1]); i++; }
        else if (a === '-maxdepth' && args[i + 1] && /^\d+$/.test(args[i + 1])) {
          maxDepth = Number(args[i + 1]);
          i++;
        }
      }
      const pathQ = psSingleQuote(path);
      const namePart = name ? ` -Filter ${psSingleQuote(name)}` : '';
      const typeIdx = args.indexOf('-type');
      const typePart = typeIdx >= 0 && args[typeIdx + 1] === 'f' ? ' -File' : '';
      const recursePart = maxDepth === 1 ? '' : ' -Recurse';
      const depthPart = maxDepth !== undefined && maxDepth > 1 ? ` -Depth ${maxDepth}` : '';
      return `Get-ChildItem -Path ${pathQ}${recursePart}${depthPart}${typePart}${namePart}`;
    }
    case 'mkdir': {
      const hasForce = /(^|\s)-p(\s|$)/.test(rest);
      const dirs = rest.replace(/^-[^\s]+\s*/, '');
      if (!dirs) return null;
      return `New-Item -ItemType Directory${hasForce ? ' -Force' : ''} -Path ${dirs}`;
    }
    case 'rm': {
      const args = splitArgs(rest);
      const targets = args.filter(a => !a.startsWith('-'));
      const flags = args.filter(a => a.startsWith('-')).join('').replace(/-/g, '').toLowerCase();
      if (targets.length === 0) return null;
      const opts = `${flags.includes('r') ? ' -Recurse' : ''}${flags.includes('f') ? ' -Force' : ''}`;
      return `Remove-Item${opts} ${targets.join(' ')}`;
    }
    case 'cp': {
      const args = splitArgs(rest);
      const targets = args.filter(a => !a.startsWith('-'));
      if (targets.length < 2) return null;
      const opts = args.some(a => a.startsWith('-') && a.toLowerCase().includes('r')) ? ' -Recurse' : '';
      return `Copy-Item${opts} ${targets.join(' ')}`;
    }
    case 'mv': {
      const args = splitArgs(rest);
      const targets = args.filter(a => !a.startsWith('-'));
      if (targets.length < 1) return null;
      return `Move-Item ${targets.join(' ')}`;
    }
    case 'touch': {
      if (!rest) return null;
      return `New-Item -ItemType File -Force -Path ${rest}`;
    }
    case 'which': {
      if (!rest) return null;
      return `(Get-Command ${rest} -ErrorAction SilentlyContinue).Source`;
    }
    case 'export': {
      const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) return null;
      return `$env:${m[1]} = ${psSingleQuote(unquote(m[2]))}`;
    }
    case 'unset': {
      if (!rest) return null;
      return `Remove-Item Env:${rest.trim()} -ErrorAction SilentlyContinue`;
    }
    case 'ls': {
      // ls 本身是 PS 别名，但 -a/-l/-la 组合参数会炸；-a → -Force（含隐藏项）
      const args = splitArgs(rest);
      const targets = args.filter(a => !a.startsWith('-'));
      const flags = args.filter(a => a.startsWith('-')).join('').replace(/-/g, '').toLowerCase();
      const force = flags.includes('a') ? ' -Force' : '';
      const t = targets.length ? ` ${targets.map(x => psSingleQuote(unquote(x))).join(' ')}` : '';
      return `Get-ChildItem${force}${t}`;
    }
    case 'pwd':
      return 'Get-Location';
    case 'date':
      return 'Get-Date';
    case 'sleep': {
      const m = rest.match(/^(\d+)$/);
      if (m) return `Start-Sleep -Seconds ${m[1]}`;
      return null;
    }
    default:
      return null;
  }
}

/** Windows 下把常见 Unix 命令段翻译成 PowerShell 写法 */
function translateUnixToPowerShell(command: string): { command: string; translated: boolean } {
  const parts = splitTopLevel(command);
  let changed = false;
  let result = '';
  for (const part of parts) {
    const translated = translateSegment(part.text);
    if (translated) changed = true;
    result += translated ?? part.text;
    if (part.sep !== undefined) result += part.sep;
  }
  return { command: result, translated: changed };
}

/** 从中间裁剪超长输出，保留开头和结尾（默认开头约 45%，结尾约 55%） */
function truncateMiddle(text: string, maxLen: number): { text: string; truncated: boolean } {
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

const UNIX_COMMAND_HINTS: Record<string, string> = {
  head: 'head → Get-Content -TotalCount N / Select-Object -First N',
  tail: 'tail → Get-Content -Tail N / Select-Object -Last N',
  cat: 'cat → Get-Content',
  grep: 'grep → Select-String',
  wc: 'wc → Measure-Object',
  find: 'find → Get-ChildItem -Recurse',
  touch: 'touch → New-Item -ItemType File -Force',
  which: 'which → Get-Command',
  curl: 'curl → Invoke-WebRequest 或 curl.exe',
  wget: 'wget → Invoke-WebRequest',
  mkdir: 'mkdir -p → New-Item -ItemType Directory -Force',
  rm: 'rm -rf → Remove-Item -Recurse -Force',
  cp: 'cp -r → Copy-Item -Recurse',
  mv: 'mv → Move-Item',
  ls: 'ls -la → Get-ChildItem -Force',
  chmod: 'chmod → Windows 权限请用 icacls / Set-Acl（Linux 权限位不适用）',
  export: 'export VAR=x → $env:VAR = "x"',
  unset: 'unset VAR → Remove-Item Env:VAR',
};

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

/** 根据错误输出生成引导性修复说明（尽力而为；无明确归因时返回空串） */
function buildErrorMessage(command: string, output: string, exitCode: number | null, cwd: string): string {
  const out = output || '';
  const low = out.toLowerCase();

  if (/command not found|is not recognized|不是内部或外部命令|无法将.*识别为/.test(low)) {
    const missing = extractMissingCommand(out, command);
    const hint = missing ? UNIX_COMMAND_HINTS[missing.toLowerCase()] : undefined;
    if (hint) {
      return `PowerShell 无法识别 Unix 命令“${missing}”。请使用 PowerShell 等价写法：${hint}。若本工具已自动翻译，结果中会同时给出 translated_command 字段。`;
    }
    if (missing.toLowerCase() === 'utf8') {
      return `PowerShell 中请使用 [System.Text.Encoding]::UTF8（不是裸 UTF8），例如：[Console]::OutputEncoding = [System.Text.Encoding]::UTF8。`;
    }
    return `PowerShell 找不到命令“${missing || '该命令'}”。可先用 Get-Command ${missing || '<名称>'} 确认命令是否安装，或改用 read/dev 等工具完成同类操作。`;
  }

  if (/cannot find (path|drive)|does not exist|找不到.*路径|路径.*不存在|不存在/.test(low)) {
    let rootItems = '';
    try {
      rootItems = fs.readdirSync(workspaceRoot()).slice(0, 30).join(', ');
    } catch { /* 忽略 */ }
    const dup = /workspace[\\/]default[\\/]workspace[\\/]default/.test(command)
      ? '；疑似重复写了 workspace/default 前缀，实际根目录只需写一次'
      : '';
    return `路径不存在或无法访问。当前工作目录：${cwd}；工作区根：${workspaceRoot()}。工作区根内容：${rootItems || '(无法读取)'}${dup}。请先确认实际路径再重试。`;
  }

  if (/unicodeencodeerror|'gbk' codec can't encode|gbk.*encode/.test(low)) {
    return `Python 输出编码错误。工具已自动注入 PYTHONIOENCODING=utf-8 / PYTHONUTF8=1；若仍出现，请在脚本开头显式执行 sys.stdout.reconfigure(encoding='utf-8')。`;
  }

  if (/syntaxerror|unexpected token/.test(low) && /python -c/.test(command)) {
    return `python -c 内嵌引号在 PowerShell 中容易转义出错；建议把 Python 代码写入临时 .py 文件，再用 python 文件路径 执行。`;
  }

  if (!out.trim() && exitCode !== 0 && /[;&|]/.test(command)) {
    return `命令整体退出码为 ${exitCode}，但没有产生输出，说明组合命令中某一段失败。建议拆成多条命令逐段执行，或在每段后用 ; echo "exit=$LASTEXITCODE" 定位失败段。`;
  }

  return '';
}

/**
 * 剥离 heredoc / here-string 载荷（数据非命令）后再做启发式扫描。
 *
 * here-string（`@'…'@` / `@"…"@`）与 bash heredoc（`<<'EOF' … EOF`）的内容是
 * 要写入文件的代码/文本载荷，不是 shell 路径语法——其中的正则字面量
 * （如 JS `/const\s+…/`，经反斜杠归一化后形似 `/const/s+…`）、代码里的
 * 路径样例常量都会被盘符/Unix 路径启发式误判（实测：GLSL 检查脚本经
 * `@'…'@ | Set-Content` 写盘被「Unix 绝对路径（/const/）」整条误拦）。
 * 剥离后，载荷之后同一行的管道/命令（`| Set-Content …`）保留继续受检。
 *
 * 匹配规则与 shell 语法对齐（匹配失败时保留原文继续扫描 → 只可能多拦
 * 不可能漏拦）：PS 开标记必须行尾（`@'⏎`）、闭标记必须行首（`⏎'@`），
 * 惰性匹配到首个闭标记即止；bash `<<X` 需后随空白/重定向/EOL（避开
 * 位移运算 `a << b`），闭定界符独占一行。
 */
function stripHeredocPayloads(command: string): string {
  return command
    // PowerShell here-string（单引号原文 / 双引号可展开）
    .replace(/@'\r?\n[\s\S]*?\r?\n'@/g, ' <heredoc-payload> ')
    .replace(/@"\r?\n[\s\S]*?\r?\n"@/g, ' <heredoc-payload> ')
    // bash heredoc：<<'X' / <<"X" / <<X …（X 行首独占一行收尾）
    .replace(/<<-?(['"]?)([A-Za-z_]\w*)\1(?=[\s>|\n]|$)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\r?\n|$)/g, ' <heredoc-payload> ');
}

/**
 * bash 命令级沙箱（启发式静态检查）：
 * 拦截允许范围外访问 —— cd .. 越界 / 盘符绝对路径（C:\）/ Unix 绝对路径 / 独立 ../ 引用。
 * 目标路径解析后落在 allowedRoots（workspaceRoot + security.allowedPaths）内则放行，
 * 与 read/write/edit 的 resolveSafePath 白名单对齐。返回违规说明或 null（允许）。
 *
 * 注意：这是纵深防御（cwd 参数校验之外），无法覆盖全部 shell 语法，
 * 但能拦截 test 实测的越界场景：cd ..、Get-Content C:\Windows\win.ini、遍历 C:\、写工作区外文件。
 * here-string/heredoc 载荷视为数据不参与扫描（见 stripHeredocPayloads）；
 * 已知残留误报：引号内直接执行的代码（node -e "…正则…"）不在剥离范围。
 */
export function bashCommandViolation(command: string, allowedRoots?: string[]): string | null {
  // 载荷先行剥离（数据非命令），其余照旧归一化反斜杠后分段扫描
  const norm = stripHeredocPayloads(command).replace(/\\/g, '/');
  const root = workspaceRoot();
  const roots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [root];
  /** 目标是否落在允许根内（与 resolveSafePath 同一判定） */
  const isAllowed = (target: string): boolean => {
    const t = path.resolve(target);
    return roots.some(r => t === r || t.startsWith(r + path.sep));
  };

  // 按命令段拆分（; && || | 换行）
  const segments = norm.split(/[;&|]|\n/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // 1. 盘符绝对路径（C:\ 或 C:/）。盘符前邻必须是行首或非「字母/数字/下划线」字符，
    //    排除 URL scheme（https:// http:// ftp:// wss:// … 字母串后的冒号+斜杠——
    //    曾把 https:// 里的 s:// 误判成 S: 盘，导致 curl https://… 整条被拦截）
    //    与 $env: / %VAR% 变量展开（无 \ / 后缀）
    const drive = seg.match(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/);
    if (drive) {
      const m = seg.match(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s;|&"'`]*/);
      const p = m ? m[0] : drive[0];
      if (!isAllowed(p)) {
        return `命令包含绝对路径（${drive[0][0].toUpperCase()}:）访问，超出允许范围，被沙箱拦截。请改用工作区内相对路径（例如 files/... 或 src/...，不要写盘符）；如确需访问白名单外路径，请先将其加入 security.allowedPaths。`;
      }
      continue; // 盘符在白名单内 → 放行
    }
    // 2. Unix 风格绝对路径（独立路径参数，如 /etc /tmp）
    const abs = seg.match(/(?:^|\s)\/(?:[a-zA-Z0-9_.-]+)(?:\/|$)/);
    if (abs) {
      const p = abs[0].trim();
      if (!isAllowed(p)) {
        return `命令包含 Unix 绝对路径（${p}）访问，超出允许范围，被沙箱拦截。请使用工作区内相对路径；确需访问白名单外路径时先加入 security.allowedPaths。`;
      }
      continue; // Unix 绝对路径在白名单内 → 放行
    }
    // 3. cd 越界：cd .. / cd ../x / cd 绝对路径（目标解析后判断）
    const cd = seg.match(/\bcd\s+("?[^\s"]+"?)/);
    if (cd) {
      const target = cd[1].replace(/^["']|["']$/g, '');
      if (target === '..' || target.startsWith('../') || target.includes('..')
        || target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
        if (!isAllowed(path.resolve(root, target))) {
          return `命令中 cd 到 "${target}" 越出允许范围，被沙箱拦截。仅允许工作区及 security.allowedPaths 白名单内目录；可用 Get-ChildItem workspace/default 查看工作区根实际目录。`;
        }
      }
    }
    // 4. 独立 ../ 引用（排除 git diff a..b 这类 token 内 ..；解析后判断）
    const refs = seg.match(/(?:^|\s)(\.\.[\\/][^\s;|&"'`]*)/g);
    if (refs) {
      for (const ref of refs) {
        const p = ref.trim();
        if (!isAllowed(path.resolve(root, p))) {
          return `命令包含 ".." 相对路径引用，可能越出允许范围，被沙箱拦截。请改用工作区内相对路径（如 src/...），不要使用 .. 上跳；确需访问白名单外路径时先加入 security.allowedPaths。`;
        }
      }
    }
  }
  return null;
}

/** bash 后台任务临时日志前缀（>1 小时清理） */
const BASH_TEMP_PREFIX = 'agentchat-bash-';

function bashTempLogPath(): string {
  return path.join(tmpdir(), `${BASH_TEMP_PREFIX}${randomBytes(8).toString('hex')}.log`);
}

/** 清理超过 1 小时的旧 bash 临时日志（非阻塞） */
function cleanupOldBashLogs(): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(tmpdir())) {
      if (!f.startsWith(BASH_TEMP_PREFIX)) continue;
      try {
        const s = fs.statSync(path.join(tmpdir(), f));
        if (now - s.birthtimeMs > 3_600_000) fs.unlinkSync(path.join(tmpdir(), f));
      } catch { /* 跳过无法 stat 的文件 */ }
    }
  } catch { /* 非关键路径 */ }
}

/**
 * 执行命令工具（支持 timeout / background / stdin）。
 *   - command：要执行的 shell 命令
 *   - cwd：工作目录（相对工作区根，默认工作区根；仅限工作区内）
 *   - timeout：超时毫秒（默认 tool.bash.defaultTimeout=30000，上限 maxTimeout=120000）
 *   - background：后台执行（detached spawn + 日志写临时文件 + 立即返回 PID，适合长驻服务）
 *   - stdin：传给命令的标准输入（可选）
 */
export function makeBashTool(config: AgentConfig, jobs?: JobService): Tool {
  const ns = getNamespaceConfig(config, NS_TOOL_BASH);
  const defaultTimeout = typeof ns.defaultTimeout === 'number' ? ns.defaultTimeout : 30_000;
  const maxTimeout = typeof ns.maxTimeout === 'number' ? ns.maxTimeout : 120_000;
  const outputMaxLen = typeof ns.outputMaxLen === 'number' ? ns.outputMaxLen : 50_000;
  return defineTool({
    name: 'bash', label: '执行命令', ns: NS_TOOL_BASH, requires: [CAPABILITY_BASE],
    description: '执行 shell 命令并返回输出。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        description: { type: 'string', description: '命令作用的一句话说明（用于任务列表展示）' },
        workdir: { type: 'string', description: '工作目录（默认沙箱工作目录）' },
        timeout: { type: 'number', description: `超时毫秒（默认 ${defaultTimeout}，上限 ${maxTimeout}）`, minimum: 1000, maximum: maxTimeout },
        background: { type: 'boolean', description: '后台执行，立即返回 job_id（用 job 工具管理）' },
      },
      required: ['command'],
    },
    // workdir 正典 / cwd 旧名；stdin 已从 schema 移除（execute 层仍兼容读取）
    execute: async ({ command, description, workdir, cwd, timeout, background, stdin }, stream, signal) => {
      const wd = workdir ?? cwd;
      const originalCommand = command == null ? '' : String(command);
      let dir: string;
      if (wd) {
        try {
          dir = resolveSafePath(config, wd);
        } catch (e) {
          return JSON.stringify({
            status: 'error',
            data: {
              message: `${(e as Error).message}。workdir 仅限工作区内（相对 workspace/default 解析）`,
            },
          });
        }
      } else {
        // 缺省 cwd = 沙箱工作目录（独立会话挂载文件夹时即挂载目录；否则工作区根）
        dir = sandboxWorkdir(config);
      }
      if (!fs.existsSync(dir)) {
        return JSON.stringify({
          status: 'error',
          data: {
            message: `工作目录不存在：${dir}（workdir 相对沙箱工作目录解析，缺省即沙箱工作目录）`,
          },
        });
      }
      // 命令级沙箱：拦截允许范围外访问（cd .. 越界 / 盘符 / 绝对路径 / ../ 引用）；
      // 与路径白名单对齐：目标解析后落在 workspaceRoot 或 security.allowedPaths 内放行
      const allowedRoots = [workspaceRoot(), ...(getAllowedPaths(config) ?? [])
        .map(a => (path.isAbsolute(a) ? a : path.resolve(workspaceRoot(), a)))];
      const violation = bashCommandViolation(originalCommand, allowedRoots);
      if (violation) {
        return JSON.stringify({
          status: 'error',
          data: { command: originalCommand, cwd: dir, message: `${violation}` },
        });
      }
      const { shell, args: shellArgs } = getShellConfig();

      // Unix → PowerShell 自动翻译（Windows PowerShell 系列；cmd 回退不支持 PS 语法）
      let commandToRun = originalCommand;
      let translatedCommand: string | undefined;
      if (process.platform === 'win32' && shell !== 'cmd') {
        const translated = translateUnixToPowerShell(originalCommand);
        if (translated.translated) {
          commandToRun = translated.command;
          translatedCommand = translated.command;
        }
      }

      // Windows (pwsh/5.1)：强制 UTF-8 输出编码（cmd 不支持该语法，跳过）
      let actualCommand = commandToRun;
      if (process.platform === 'win32' && shell !== 'cmd') {
        actualCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${commandToRun}`;
      }

      // Python 默认 UTF-8：消除 Windows 下 print 中文的 GBK UnicodeEncodeError
      const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

      // ---- 后台执行：detached spawn + 日志文件，立即返回 PID ----
      if (background === true) {
        try {
          const logFile = bashTempLogPath();
          const fd = fs.openSync(logFile, 'a');
          const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], {
            cwd: dir,
            env: childEnv,
            // Windows：detached:false + unref 即可让子进程存活；Unix：detached:true 创建独立进程组
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', fd, fd],
            shell: false,
          });
          child.unref();
          let jobId: string | undefined;
          if (child.pid != null && jobs) {
            try {
              jobId = jobs.start({
                kind: 'bash',
                label: originalCommand,
                ownerAgentId: config.agent_id,
                meta: { pid: child.pid, command: originalCommand, cwd: dir, logFile },
                run: () => {
                  // 进程 close → done 终态（非零退出 = completed + detail，报告不报错）
                  const done = new Promise<import('@agentchat/jobs').JobOutcome>((resolve) => {
                    child.on('close', (code, signal) => {
                      resolve(signal !== null
                        ? { status: 'killed', detail: `signal: ${signal}` }
                        : { status: 'completed', detail: `exit code: ${code ?? 0}` });
                    });
                  });
                  return { cancel: () => killProcessTree(child.pid!), done };
                },
              });
            } catch (err: any) {
              return JSON.stringify({
                status: 'error',
                data: { command: originalCommand, cwd: dir, message: `后台任务登记失败: ${err?.message ?? String(err)}` },
              });
            }
          }
          return JSON.stringify({
            status: 'launched',
            data: {
              command: originalCommand,
              ...(translatedCommand ? { translated_command: translatedCommand } : {}),
              cwd: dir,
              background: true,
              launched: true,
              exit_code: 0,
              success: true,
              pid: child.pid,
              ...(jobId ? { job_id: jobId } : {}),
              log_file: logFile,
              message: `已在后台启动 (任务 ${jobId ?? '（无 id）'}, PID ${child.pid})。日志：${logFile}。用 job 工具管理（list/kill/logs），或 Stop-Process -Id ${child.pid} 停止。`,
            },
          });
        } catch (err: any) {
          return JSON.stringify({
            status: 'error',
            data: { command: originalCommand, cwd: dir, message: `后台启动失败: ${err?.message ?? String(err)}` },
          });
        }
      }

      // ---- 前台执行（流式输出 + 超时 + stdin）----
      cleanupOldBashLogs();
      return new Promise<string>((resolve) => {
        let output = '';
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        // timeout 可调，clamp 到 maxTimeout
        const effectiveTimeout = typeof timeout === 'number' && timeout > 0
          ? Math.min(timeout, maxTimeout)
          : defaultTimeout;

        const child: ChildProcess = spawn(shell, [...shellArgs, actualCommand], {
          cwd: dir,
          env: childEnv,
          windowsHide: true,
          stdio: stdin != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        const onData = (data: Buffer) => {
          const chunk = data.toString('utf-8');
          output += chunk;
          stream?.onChunk(chunk);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        if (stdin != null && child.stdin) {
          child.stdin.write(stdin);
          child.stdin.end();
        }

        if (effectiveTimeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, effectiveTimeout);
        }
        const onAbort = () => { if (child.pid) killProcessTree(child.pid); };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (timedOut) {
            resolve(JSON.stringify({ status: 'timeout', data: { command: originalCommand, cwd: dir, message: `命令超时（${effectiveTimeout}ms）。建议增大 timeout 参数或改用 background 后台执行。`, timed_out: true } }));
          } else {
            // 结构化结果：与 read/write/edit 等工具一致（前端 ToolResultTerminal 依赖
            // status+data{command,cwd,output,exit_code} 渲染终端卡片；纯文本会让
            // 工具卡退化为普通文本，且流式中无法实时升级为专用卡片）。
            const exitCode = typeof code === 'number' ? code : null;
            const success = exitCode === 0;
            const totalBytes = Buffer.byteLength(output, 'utf-8');
            const displayed = truncateMiddle(output, outputMaxLen);
            const guidance = success ? '' : buildErrorMessage(originalCommand, output, exitCode, dir);
            resolve(JSON.stringify({
              status: success ? 'success' : 'error',
              data: {
                command: originalCommand,
                ...(translatedCommand ? { translated_command: translatedCommand } : {}),
                cwd: dir,
                output: displayed.text || '(无输出)',
                exit_code: exitCode,
                success,
                truncated: displayed.truncated,
                total_bytes: totalBytes,
                timed_out: false,
                ...(guidance ? { message: guidance } : {}),
              },
            }));
          }
        });
        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(JSON.stringify({ status: 'error', data: { command: originalCommand, cwd: dir, message: err?.message ?? String(err) } }));
        });
      });
    },
    extractLabel: (args) => (typeof args.description === 'string' && args.description.trim())
      ? args.description.trim()
      : args.command,
  });
}

/** 文件类工具工厂（per-Agent 烘焙沙箱） */

/** shell 工具族（bash + job 后台任务管理；jobs 服务由插件行注入） */
export function makeShellTools(config: AgentConfig, jobs?: JobService): Tool[] {
  return [makeBashTool(config, jobs), makeJobTool(config, jobs)];
}
