// ============================================================
// ac-shell-tools/src/unix-translate.ts —— Unix → PowerShell 命令翻译
// （src shell 原样平移）
//
// Windows PowerShell 系列下把常见 Unix 命令段翻译成 PS 等价写法：
// head/tail/cat/grep/wc/find/mkdir/rm/cp/mv/touch/which/export/unset/
// ls/pwd/date/sleep。按顶层分隔符拆段（引号内分隔符不拆），逐段翻译。
// ============================================================

interface CommandPart {
  text: string;
  sep?: string;
}

/** 按顶层分隔符拆分命令，忽略引号内的 ; | && 等内容 */
function splitTopLevel(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let cur = '';
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '`') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '`') {
      escaped = true;
      cur += ch;
      continue;
    }
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
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '`') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '`') {
      escaped = true;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
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
      return 'Select-Object -First 10';
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
      return 'Select-Object -Last 10';
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
        const paths = files.map((f) => psSingleQuote(unquote(f))).join(',');
        return `Get-ChildItem -Path ${paths} -Recurse -File | Select-String -Pattern ${patternQ} ${caseArg}${lineOut}`;
      }
      if (files.length > 0) {
        const paths = files.map((f) => psSingleQuote(unquote(f))).join(',');
        return `Select-String -Path ${paths} -Pattern ${patternQ} ${caseArg}${lineOut}`;
      }
      if (flags.has('r')) {
        return `Get-ChildItem -Recurse -File | Select-String -Pattern ${patternQ} ${caseArg}${lineOut}`;
      }
      return `Select-String -Pattern ${patternQ} ${caseArg}${lineOut}`;
    }
    case 'wc': {
      const args = splitArgs(rest);
      const files = args.filter((a) => !a.startsWith('-'));
      const flags = args.filter((a) => a.startsWith('-')).join('').replace(/-/g, '');
      const fileList = files.map((f) => psSingleQuote(unquote(f))).join(',');
      const src = fileList ? `Get-Content ${fileList}` : '';
      if (flags.includes('l')) {
        if (!src) return 'Measure-Object -Line | Select-Object -ExpandProperty Lines';
        return `(${src} | Measure-Object -Line).Lines`;
      }
      if (flags.includes('c')) {
        if (files.length === 1) return `(Get-Item ${fileList}).Length`;
        if (!src) return 'Measure-Object -Character | Select-Object -ExpandProperty Characters';
        return `(${src} | Measure-Object -Character).Characters`;
      }
      if (flags.includes('w')) {
        if (!src) return 'Measure-Object -Word | Select-Object -ExpandProperty Words';
        return `(${src} | Measure-Object -Word).Words`;
      }
      if (fileList) return `(${src} | Measure-Object -Line -Word -Character) | Format-List`;
      return 'Measure-Object -Line -Word -Character';
    }
    case 'find': {
      const args = splitArgs(rest);
      let path = '.';
      let name: string | undefined;
      let maxDepth: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (i === 0 && !a.startsWith('-')) path = unquote(a);
        else if (a === '-name' && args[i + 1]) {
          name = unquote(args[i + 1]);
          i++;
        } else if (a === '-maxdepth' && args[i + 1] && /^\d+$/.test(args[i + 1])) {
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
      const targets = args.filter((a) => !a.startsWith('-'));
      const flags = args.filter((a) => a.startsWith('-')).join('').replace(/-/g, '').toLowerCase();
      if (targets.length === 0) return null;
      const opts = `${flags.includes('r') ? ' -Recurse' : ''}${flags.includes('f') ? ' -Force' : ''}`;
      return `Remove-Item${opts} ${targets.join(' ')}`;
    }
    case 'cp': {
      const args = splitArgs(rest);
      const targets = args.filter((a) => !a.startsWith('-'));
      if (targets.length < 2) return null;
      const opts = args.some((a) => a.startsWith('-') && a.toLowerCase().includes('r')) ? ' -Recurse' : '';
      return `Copy-Item${opts} ${targets.join(' ')}`;
    }
    case 'mv': {
      const args = splitArgs(rest);
      const targets = args.filter((a) => !a.startsWith('-'));
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
      const targets = args.filter((a) => !a.startsWith('-'));
      const flags = args.filter((a) => a.startsWith('-')).join('').replace(/-/g, '').toLowerCase();
      const force = flags.includes('a') ? ' -Force' : '';
      const t = targets.length ? ` ${targets.map((x) => psSingleQuote(unquote(x))).join(' ')}` : '';
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
export function translateUnixToPowerShell(command: string): { command: string; translated: boolean } {
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
