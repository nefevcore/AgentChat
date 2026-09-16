// ============================================================
// ac-shell-tools/src/unix-translate.ts —— Unix → PowerShell 命令翻译
//
// Windows PowerShell 系列下把常见 Unix 命令段翻译成 PS 等价写法。
// 按顶层分隔符拆段（引号内分隔符不拆），逐段翻译。
//
// 【fail-closed 原则】（2026-09-16 全面审查重写）
// 旧实现遇到不认识的 flag/谓词/参数组合时"静默丢弃、继续翻"，产生过：
// grep -v 反转丢失（结果与意图相反且 exit 0）、tail -f 丢操作数静默
// 空成功、--include 里的 i 泄漏成 -i、find 未识别谓词丢弃扩大搜索
// 范围、export 值里的 $PATH 变字面量污染环境。对 Agent 的反馈回路
// 这是毒药：写了 A、执行了 B、报错归因于 A。新原则：**未识别的成分
// → 该段不翻译**（返回 null 原样透传），让命令以 Unix 原文失败——
// 报错至少能对上 Agent 写的东西；认识的形状则保证译文语义完备。
//
// 词表纪律：每个命令的 KNOWN 集只放「译文能忠实表达」的 flag；
// 其余 flag 一律不在词表里 → collectFlags 直接放弃翻译。不设
// "认识但忽略"的中间态——忽略即静默改语义，正是本次要根除的。
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

/** 裸 token 里含 Unix 变量展开（$VAR / ${VAR}）？PS 不会展开它 → 翻译必错 */
function hasUnixVarExpansion(s: string): boolean {
  const bare = /^["']/.test(s) && /['"]$/.test(s) ? unquote(s) : s;
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(bare);
}

/**
 * 重定向 token 判定（完整算子形态：`2>&1` / `1>&2` / `2>$null` /
 * `2>/dev/null` / `>` / `>>`）。附着重定向（`>out.txt`）由
 * expandAttachedRedirects 拆开后再判定。
 * （2026-09-02 反馈：`ls path 2>&1` 曾被当路径参数包成字面量。）
 */
function isRedirectToken(a: string): boolean {
  return (
    /^(?:[012]?>>?&[012]|[012]?>>?)$/.test(a) ||
    /^[012]?>>?\$null$/.test(a) ||
    /^[012]?>>?\/dev\/null$/.test(a)
  );
}

/** 重定向归一（PS 同形）：/dev/null → $null */
function normalizeRedirect(a: string): string {
  return a.replace(/\/dev\/null$/, '$null');
}

/**
 * 附着重定向展开：`>out.txt` / `2>err.log` / `>>log` → 算子与目标分离。
 * 不展开会把整个 token 当路径（pwsh 原样 `ls >>out.txt` 本可运行，
 * 翻译反而弄错——2026-09-16 审查补）。`2>&1` 等完整算子先被
 * isRedirectToken 截住，不会进这里的歧义分支。
 */
function expandAttachedRedirects(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (isRedirectToken(a) || a.startsWith('-')) {
      out.push(a);
      continue;
    }
    const m = a.match(/^([012]?>>?)(.+)$/);
    if (m) {
      out.push(m[1], m[2] === '/dev/null' ? '$null' : m[2]);
      continue;
    }
    out.push(a);
  }
  return out;
}

/** 参数 + 附着重定向展开（操作数收集类命令统一入口） */
function splitOperands(input: string): string[] {
  return expandAttachedRedirects(splitArgs(input));
}

/**
 * 按首个重定向算子切分：其后全部视为重定向尾部（算子 + 目标），
 * 从操作数集中剔除、原样（归一 /dev/null）拼回译文尾。防止
 * `cat a > b` 的 b 进文件集、`ls > out.txt` 的 out.txt 进路径集。
 */
function splitRedirectTail(args: string[]): { operands: string[]; tail: string } {
  const idx = args.findIndex(isRedirectToken);
  if (idx < 0) return { operands: args, tail: '' };
  const tailParts = args.slice(idx).map((t) =>
    isRedirectToken(t) ? normalizeRedirect(t) : t === '/dev/null' ? '$null' : t,
  );
  return { operands: args.slice(0, idx), tail: tailParts.join(' ') };
}

/**
 * 归集短 flag 集（`-abc` 字符汤拆散）。词表外 flag → null（fail-closed：
 * 未识别即整段不翻译，不设"认识但忽略"的中间态）。
 */
function collectFlags(args: string[], known: ReadonlySet<string>): Set<string> | null {
  const flags = new Set<string>();
  for (const a of args) {
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a))) {
      for (const f of a.slice(a.startsWith('--') ? 2 : 1)) {
        if (!known.has(f)) return null;
        flags.add(f);
      }
    }
  }
  return flags;
}

// ── grep ──────────────────────────────────────────────────────
// 只翻译输出形状能忠实表达的形状：{-i -v -n -r -h}（含长等价）+ 文件/管道。
// 多文件/递归时 grep 输出带文件名前缀——译文同样带（$_.Path），否则
// Agent 无从知道匹配来自哪个文件。-l/-w/-E/-c/-A/-B/-C/-e/-F/-s… 与
// --include/--exclude 系一律不在词表 → 放弃翻译（原文失败可归因，
// 好过译文静默错义）。
const GREP_KNOWN = new Set(['i', 'v', 'n', 'r', 'h']);
const GREP_LONG_EQUIV: Record<string, string> = {
  '--ignore-case': 'i',
  '--invert-match': 'v',
  '--recursive': 'r',
  '--line-number': 'n',
  '--no-filename': 'h',
};
/** 长 flag 中「译文形状本就同形、可安全丢弃」的（--text：二进制当文本搜） */
const GREP_LONG_DROP = new Set(['--text']);

function translateGrep(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  let i = 0;
  const flagArgs: string[] = [];
  for (; i < operands.length; i++) {
    const a = operands[i];
    if (a.startsWith('-') && a.length > 1) {
      flagArgs.push(a);
      continue;
    }
    break;
  }
  const pattern = operands[i];
  const files = operands.slice(i + 1);
  if (pattern === undefined) return null;
  const flags = collectFlags(flagArgs.filter((a) => !a.startsWith('--')), GREP_KNOWN);
  if (flags === null) return null;
  for (const a of flagArgs) {
    if (!a.startsWith('--')) continue;
    const equiv = GREP_LONG_EQUIV[a];
    if (equiv) flags.add(equiv);
    else if (!GREP_LONG_DROP.has(a)) return null;
  }

  const patternQ = psSingleQuote(unquote(pattern));
  const caseArg = flags.has('i') ? '-CaseSensitive:$false' : '-CaseSensitive';
  // 输出前缀形状对齐 grep：多文件/递归带文件名前缀（-h 关掉）；
  // -n 加行号。$_.Path 与 grep 的相对路径前缀格式不同，但归因信息完整。
  const withPath = (files.length > 1 || flags.has('r')) && !flags.has('h');
  const lineOut = withPath
    ? flags.has('n')
      ? ' | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }'
      : ' | ForEach-Object { "$($_.Path):$($_.Line)" }'
    : flags.has('n')
      ? ' | ForEach-Object { if ($_.LineNumber) { "$($_.LineNumber):$($_.Line)" } else { $_.Line } }'
      : ' | ForEach-Object { $_.Line }';
  const notMatch = flags.has('v') ? ' -NotMatch' : '';
  const tailPart = tail ? ` ${tail}` : '';
  if (flags.has('r')) {
    // 递归形：目录展开交给 Get-ChildItem -Recurse -File
    const paths = files.length > 0 ? files.map((f) => psSingleQuote(unquote(f))).join(',') : '.';
    return `Get-ChildItem -Path ${paths} -Recurse -File | Select-String -Pattern ${patternQ}${notMatch} ${caseArg}${lineOut}${tailPart}`;
  }
  if (files.length > 0) {
    // 非递归文件形。目录操作数（尾 / 或 \）GNU grep 直接报错，而
    // Select-String -Path 对目录静默空结果——反馈回路失真 → 不翻
    if (files.some((f) => /[\\/]$/.test(unquote(f)))) return null;
    const paths = files.map((f) => psSingleQuote(unquote(f))).join(',');
    return `Select-String -Path ${paths} -Pattern ${patternQ}${notMatch} ${caseArg}${lineOut}${tailPart}`;
  }
  return `Select-String -Pattern ${patternQ}${notMatch} ${caseArg}${lineOut}${tailPart}`;
}

// ── head / tail ───────────────────────────────────────────────
// 只翻译 [-n N | -N] [file…]；-c（字节）/ -f（follow）/ -q / -n +5
//（跳过前缀）等语义无忠实等价 → 放弃翻译。
function translateHeadTail(cmd: 'head' | 'tail', rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  let count: number | undefined;
  const files: string[] = [];
  for (let i = 0; i < operands.length; i++) {
    const a = operands[i];
    if (a === '-n' && /^\d+$/.test(operands[i + 1] ?? '')) {
      count = Number(operands[i + 1]);
      i++;
      continue;
    }
    if (/^-\d+$/.test(a)) {
      count = Number(a.slice(1));
      continue;
    }
    if (a.startsWith('-') && a.length > 1) return null;
    files.push(a);
  }
  const n = count ?? 10;
  const pos = cmd === 'head' ? 'First' : 'Last';
  const tailPart = tail ? ` ${tail}` : '';
  if (files.length > 0) {
    const paths = files.map((f) => psSingleQuote(unquote(f))).join(',');
    return `Get-Content ${paths} -${pos === 'First' ? 'TotalCount' : 'Tail'} ${n}${tailPart}`;
  }
  return `Select-Object -${pos} ${n}${tailPart}`;
}

// ── cat ───────────────────────────────────────────────────────
// 只认纯文件操作数；-n/-A/-b/-s 等编号/压缩空行 flag 无忠实等价 → 放弃。
function translateCat(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  const files: string[] = [];
  for (const a of operands) {
    if (a.startsWith('-') && a.length > 1) return null;
    files.push(a);
  }
  if (files.length === 0) return null;
  const paths = files.map((f) => psSingleQuote(unquote(f))).join(',');
  return `Get-Content ${paths}${tail ? ` ${tail}` : ''}`;
}

// ── wc ────────────────────────────────────────────────────────
// -l/-w/-c 单维可精确翻译；-m/-L 及多维权衡走三指标合并形（数据齐备，
// 只是多了没要的维度）；长 flag（--lines 等）→ 放弃。无文件 = 管道形。
function translateWc(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  const KNOWN = new Set(['l', 'w', 'c']);
  const files: string[] = [];
  const dims = new Set<string>();
  for (const a of operands) {
    if (a.startsWith('-') && a.length > 1) {
      for (const f of a.replace(/^-+/, '')) {
        if (!KNOWN.has(f)) return null;
        dims.add(f);
      }
      continue;
    }
    files.push(a);
  }
  const fileList = files.map((f) => psSingleQuote(unquote(f))).join(',');
  const src = fileList ? `Get-Content ${fileList}` : '';
  const tailPart = tail ? ` ${tail}` : '';
  if (dims.size === 0) {
    if (!src) return null; // 裸 wc 无管道上下文，无意义 → 不翻
    return `(${src} | Measure-Object -Line -Word -Character) | Format-List${tailPart}`;
  }
  if (dims.size > 1) {
    if (!src) return `Measure-Object -Line -Word -Character | Format-List${tailPart}`;
    return `(${src} | Measure-Object -Line -Word -Character) | Format-List${tailPart}`;
  }
  if (dims.has('l')) {
    if (!src) return `Measure-Object -Line | Select-Object -ExpandProperty Lines${tailPart}`;
    return `(${src} | Measure-Object -Line).Lines${tailPart}`;
  }
  if (dims.has('c')) {
    if (files.length === 1) return `(Get-Item ${fileList}).Length${tailPart}`;
    // 管道形 -c（字节计数）在 PS 只能按字符近似（多字节文本出错）→ 不翻
    return null;
  }
  // dims = {w}
  if (!src) return `Measure-Object -Word | Select-Object -ExpandProperty Words${tailPart}`;
  return `(${src} | Measure-Object -Word).Words${tailPart}`;
}

// ── find ──────────────────────────────────────────────────────
// 只翻译 [path] [-maxdepth N] [-name PAT] [-type f|d]；-exec/-not/
// -path/-newer/-mtime/复合条件等 → 放弃（静默丢谓词会扩大搜索范围）。
function translateFind(rest: string): string | null {
  const args = splitOperands(rest);
  let path = '.';
  let name: string | undefined;
  let maxDepth: number | undefined;
  let typeFilter: ' -File' | ' -Directory' | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i === 0 && !a.startsWith('-')) {
      path = unquote(a);
      continue;
    }
    if (a === '-name' && args[i + 1] !== undefined) {
      name = unquote(args[i + 1]);
      i++;
      continue;
    }
    if (a === '-maxdepth' && /^\d+$/.test(args[i + 1] ?? '')) {
      maxDepth = Number(args[i + 1]);
      i++;
      continue;
    }
    if (a === '-type' && (args[i + 1] === 'f' || args[i + 1] === 'd')) {
      typeFilter = args[i + 1] === 'f' ? ' -File' : ' -Directory';
      i++;
      continue;
    }
    return null;
  }
  const pathQ = psSingleQuote(path);
  const namePart = name !== undefined ? ` -Filter ${psSingleQuote(name)}` : '';
  const recursePart = maxDepth === 1 ? '' : ' -Recurse';
  const depthPart = maxDepth !== undefined && maxDepth > 1 ? ` -Depth ${maxDepth}` : '';
  return `Get-ChildItem -Path ${pathQ}${recursePart}${depthPart}${typeFilter ?? ''}${namePart}`;
}

// ── mkdir / touch ─────────────────────────────────────────────
function translateMkdir(rest: string): string | null {
  const args = splitOperands(rest);
  const dirs: string[] = [];
  let force = false;
  for (const a of args) {
    if (a === '-p' || a === '--parents') {
      force = true;
      continue;
    }
    if (a.startsWith('-')) return null; // -m 权限等无等价 → 不翻
    dirs.push(a);
  }
  if (dirs.length === 0) return null;
  const paths = dirs.map((d) => psSingleQuote(unquote(d))).join(',');
  return `New-Item -ItemType Directory${force ? ' -Force' : ''} -Path ${paths}`;
}

function translateTouch(rest: string): string | null {
  const args = splitOperands(rest);
  const files: string[] = [];
  for (const a of args) {
    // -t/-d/-r 时间戳语义 New-Item 无等价物；-c（不创建）与 -Force 相反 → 全不翻
    if (a.startsWith('-') && a.length > 1) return null;
    files.push(a);
  }
  if (files.length === 0) return null;
  const paths = files.map((f) => psSingleQuote(unquote(f))).join(',');
  return `New-Item -ItemType File -Force -Path ${paths}`;
}

// ── rm / cp / mv ──────────────────────────────────────────────
// 多目标统一数组绑定（'a','b'）——旧实现空格连接多目标在 pwsh 是
// 位置参数绑定错误（"找不到接受自变量"）。目标含 Unix 变量展开不翻。
function translateRm(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  const flags = collectFlags(operands.filter((a) => a.startsWith('-')), new Set(['r', 'R', 'f']));
  if (flags === null) return null; // -i/-v/--preserve-root 等 → 不翻
  const targets = operands.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) return null;
  if (targets.some(hasUnixVarExpansion)) return null;
  const opts = `${flags.has('r') || flags.has('R') ? ' -Recurse' : ''}${flags.has('f') ? ' -Force' : ''}`;
  const targetList = targets.map((t) => psSingleQuote(unquote(t))).join(',');
  return `Remove-Item${opts} ${targetList}${tail ? ` ${tail}` : ''}`.trim();
}

function translateCp(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  const flags = collectFlags(operands, new Set(['r', 'R', 'f']));
  if (flags === null) return null; // -p（保属性）/-l/-s/-u 等 → 不翻
  const targets = operands.filter((a) => !a.startsWith('-'));
  if (targets.length < 2) return null;
  if (targets.some(hasUnixVarExpansion)) return null;
  const opts = flags.has('r') || flags.has('R') ? ' -Recurse' : '';
  const srcs = targets.slice(0, -1).map((t) => psSingleQuote(unquote(t))).join(',');
  const dst = psSingleQuote(unquote(targets[targets.length - 1]));
  return `Copy-Item${opts} ${srcs} ${dst}${tail ? ` ${tail}` : ''}`.trim();
}

function translateMv(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  const targets = operands.filter((a) => !a.startsWith('-'));
  if (targets.length < 2) return null;
  if (targets.some(hasUnixVarExpansion)) return null;
  const srcs = targets.slice(0, -1).map((t) => psSingleQuote(unquote(t))).join(',');
  const dst = psSingleQuote(unquote(targets[targets.length - 1]));
  return `Move-Item ${srcs} ${dst}${tail ? ` ${tail}` : ''}`.trim();
}

// ── which / export / unset ────────────────────────────────────
function translateWhich(rest: string): string | null {
  const args = splitOperands(rest);
  if (args.length === 0) return null;
  if (args.some((a) => a.startsWith('-'))) return null; // -a 列出全部 → 不翻
  const names = args.map((n) => psSingleQuote(unquote(n))).join(',');
  return `(Get-Command ${names} -ErrorAction SilentlyContinue).Source`;
}

function translateExport(rest: string): string | null {
  const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) return null;
  // 值里含 Unix 变量展开（$PATH 等）：$env: 赋值不会展开它，字面量
  // 会污染环境变量 → 不翻（fail-closed）
  if (hasUnixVarExpansion(m[2])) return null;
  return `$env:${m[1]} = ${psSingleQuote(unquote(m[2]))}`;
}

function translateUnset(rest: string): string | null {
  if (!rest) return null;
  return `Remove-Item Env:${rest.trim()} -ErrorAction SilentlyContinue`;
}

// ── ls ────────────────────────────────────────────────────────
// -a/-l（-Force 含隐藏项）可翻；-h（人类可读）纯显示可丢；
// -t/-r/-S/-F/-1/-d 排序/格式/目录自身语义 → 不在词表，放弃翻译。
function translateLs(rest: string): string | null {
  const { operands, tail } = splitRedirectTail(splitOperands(rest));
  const flags = collectFlags(operands, new Set(['a', 'l', 'h']));
  if (flags === null) return null;
  const targets = operands.filter((a) => !a.startsWith('-'));
  const force = flags.has('a') || flags.has('l') ? ' -Force' : '';
  const t = targets.length ? ` ${targets.map((x) => psSingleQuote(unquote(x))).join(',')}` : '';
  return `Get-ChildItem${force}${t}${tail ? ` ${tail}` : ''}`;
}

// ── date / sleep / pwd ────────────────────────────────────────
function translateSleep(rest: string): string | null {
  // 裸秒数（含小数）与 s/m/h 单位可翻；复合（5m 30s）等 → 不翻
  const m = rest.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return `Start-Sleep -Seconds ${m[1]}`;
  const m2 = rest.match(/^([\d.]+)\s*([smh])$/i);
  if (m2) {
    const unit = m2[2].toLowerCase();
    const unitArg = unit === 's' ? '-Seconds' : unit === 'm' ? '-Minutes' : '-Hours';
    return `Start-Sleep ${unitArg} ${m2[1]}`;
  }
  return null;
}

/** 翻译单个命令段；返回 null 表示无需/无法翻译（fail-closed 原样透传） */
function translateSegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const first = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)/);
  if (!first) return null;
  const cmd = first[1].toLowerCase();
  const rest = trimmed.slice(first[0].length).trim();
  // 段内含命令替换/子 shell（$(...) 或 `...`）：嵌套层里还有 Unix 命令，
  // 顶层翻译改不动嵌套段 → 整段 fail-closed（原文失败可归因）
  if (/\$\(|`/.test(rest)) return null;

  switch (cmd) {
    case 'head':
      return translateHeadTail('head', rest);
    case 'tail':
      return translateHeadTail('tail', rest);
    case 'cat':
      return translateCat(rest);
    case 'grep':
      return translateGrep(rest);
    case 'wc':
      return translateWc(rest);
    case 'find':
      return translateFind(rest);
    case 'mkdir':
      return translateMkdir(rest);
    case 'rm':
      return translateRm(rest);
    case 'cp':
      return translateCp(rest);
    case 'mv':
      return translateMv(rest);
    case 'touch':
      return translateTouch(rest);
    case 'which':
      return translateWhich(rest);
    case 'export':
      return translateExport(rest);
    case 'unset':
      return translateUnset(rest);
    case 'ls':
      return translateLs(rest);
    case 'pwd':
      return 'Get-Location';
    case 'date':
      // 无参数 → Get-Date；格式串（+%s 等）输出语义差异大 → 不翻
      return rest ? null : 'Get-Date';
    case 'sleep':
      return translateSleep(rest);
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
