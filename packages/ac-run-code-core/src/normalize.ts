// ============================================================
// ac-run-code-core/src/normalize.ts —— 源码词法归一（可擦除 TS 前置层）
//
// 模型源码常见语感漂移的确定性救活（cr-59 # 注释归一起源；本文件
// 自 worker.ts 迁入并扩展——worker 顶层执行 main()，纯函数须住纯库
// 才可单测；prompt.ts/tool.ts 已同包引用先例，bundle 经 esbuild 打包
// workspace 依赖，dev/bundle 双形态无差）。
//
// 全部纯函数：零 cordis/node:worker_threads 依赖，共享 lexicalRegionEnd
// 词法骨架。
// ============================================================
// ── 词法骨架 + # 注释规范化（cr-59）──

/**
 * 词法骨架：src[i] 起若为字符串/模板/正则字面量或注释，返回其结束索引
 * （region 恰含首尾界定符）；否则返回 i。正则/除法二义按启发式判——
 * 误读仅导致该段被整体跳过（调用方按原文透传，零破坏）。
 */
export function lexicalRegionEnd(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) {
      if (src[j] === '\\') j += 1;
      j += 1;
    }
    return Math.min(j + 1, src.length);
  }
  if (c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') {
        // 插值段：嵌套深度走到配对 }——其间的字符串/模板/注释整段跳过
        //（改写器会变更源码，插值内文本零触碰）
        let depth = 1;
        let k = j + 2;
        while (k < src.length && depth > 0) {
          const ch = src[k];
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
          else if (ch === '"' || ch === "'" || ch === '`' || (ch === '/' && (src[k + 1] === '/' || src[k + 1] === '*'))) {
            const sub = lexicalRegionEnd(src, k);
            k = sub > k ? sub : k + 1;
            continue;
          }
          k += 1;
        }
        j = k;
        continue;
      }
      j += 1;
    }
    return src.length;
  }
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
  }
  if (c === '/' && src[i + 1] === '*') {
    const close = src.indexOf('*/', i + 2);
    return close === -1 ? src.length : close + 2;
  }
  if (c === '/') {
    const m = /^\/((?:[^*\n\\[…\r]|\[(?:[^\]\\]|\\.)*\]|\\.)+)\/[a-z]*/.exec(src.slice(i));
    if (m !== null) return i + m[0].length;
  }
  return i;
}

/**
 * # → // 规范化。# 非 TS 注释符（私有字段除外）——shell/Python 语感
 * 漂移混入即校验失败；中文 # 注释更会骗过擦除、在 V8 编译才挂且报错无
 * 行号（实测），模型无从定位学习。擦除前确定性归一：
 * · #!、# 后接空格/Tab/非 ASCII——判为注释改写 //；
 * · 紧邻标识符（#x，前后无空白）= class 私有字段/访问语法，不动；# 前
 *   是 '.' 同样不动（obj.#x）。中缀紧贴形态（a #b）罕见且与私有字段语法
 *   无法局部区分——保守不动，漏网交由报错提示兜底。
 */
export function normalizeHashComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const end = lexicalRegionEnd(src, i);
    if (end > i) {
      out.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (src[i] === '#') {
      const after = src[i + 1] ?? '';
      const before = i === 0 ? '' : src[i - 1];
      const shebangOrSpaced = after === '!' || after === ' ' || after === '\t' || after.charCodeAt(0) > 0x7f;
      const idiom = after !== '#' && !/[\w$\s]/.test(after) && !/[\w$.]/.test(before);
      if (shebangOrSpaced || idiom) {
        out.push('//');
        i += 1;
        continue;
      }
    }
    out.push(src[i]);
    i += 1;
  }
  return out.join('');
}

/** # 注释漂移的修复提示文案（擦除失败与 V8 编译失败两路共用） */
export const HASH_HINT = '# 不是 TS 注释符——行注释一律 //、块注释 /* */（#x 是 class 私有字段语法，须在 class 内使用）';

/** 代码位首个 # 的索引（词法骨架跳过字符串/模板/正则/注释）；无则 undefined */
export function indexCodeHash(src: string): number | undefined {
  for (let i = 0; i < src.length; ) {
    const end = lexicalRegionEnd(src, i);
    if (end > i) { i = end; continue; }
    if (src[i] === '#') return i;
    i += 1;
  }
  return undefined;
}

/** 词法区域（字符串/模板/正则/注释）等长掩蔽为空格——保留结构与行号 */
function maskLexicalRegions(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const end = lexicalRegionEnd(src, i);
    if (end > i) { out += ' '.repeat(end - i); i = end; continue; }
    out += src[i];
    i += 1;
  }
  return out;
}

// ── 自由变量扫描（lib.define 防呆告警，非安全边界）──

/** 词法白名单：JS/Node 常用全局 + 保留字——都不算自由变量 */
const LEXER_GLOBALS = new Set([
  // JS 内置
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Date',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'RegExp', 'BigInt', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'structuredClone', 'console', 'globalThis', 'Infinity', 'NaN', 'undefined',
  // Node 运行时（worker 内在场）
  'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // 闭包内置参数（库内可调工具）
  'tools', 'lib', 'log', 'arguments', 'this',
]);
const LEXER_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of',
  'delete', 'void', 'await', 'yield', 'async', 'function', 'class', 'const', 'let', 'var',
  'extends', 'super', 'import', 'export', 'true', 'false', 'null', 'as', 'satisfies',
  'keyof', 'readonly', 'type', 'interface', 'enum', 'namespace', 'declare',
]);

/**
 * 词法级自由变量扫描（近似——告警用，非精确作用域分析）。
 *
 * 动机（2026-09-21 追记 Ⓐ 延伸实测）：lib.define('trap', (s) => s.slice(0, LIMIT))
 * 注册成功（试求值只造函数不执行体）、resolve 成功（返回可调用函数）、同程序直调
 * 原函数也成功（闭包活着）——唯独跨程序 resolve 后调用炸 ReferenceError。
 * 「测试时好、复用时炸」的完美静默陷阱，define 期就该露头。
 *
 * 近似策略（漏报可接受、误报尽量压）：剥字符串/模板/注释 → 收集声明名
 * （const/let/var/function/class）+ 参数名（所有「(...) =>」与「function (...)」
 * 的括号段标识符，含默认值/解构成员——误入参数集是漏报方向）→ 收集剩余裸
 * 标识符引用（跳过属性访问 .x / ?.x 与对象字面量 key x:）→ 差集即自由变量。
 */
export function scanFreeVariables(src: string): string[] {
  // 1. 词法区域等长掩蔽（骨架单源——见 lexicalRegionEnd）
  const stripped = maskLexicalRegions(src);
  // 2. 声明名 + 参数名收集（近似并集）
  const bound = new Set<string>();
  for (const m of stripped.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!);
  // 参数列表：(...) => 与 function (...)（[^()] 不含嵌套，内层括号自成参数段）
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(p[0]);
  }
  for (const m of stripped.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(p[0]);
  }
  // 单参无括号箭头：x => ...
  for (const m of stripped.matchAll(/(^|[^\w$.])\s*([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[2]!);
  // catch (e)
  for (const m of stripped.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) bound.add(m[1]!);
  // 3. 引用收集：跳过属性访问（.x / ?.x）与对象字面量 key（x:）
  const free = new Set<string>();
  const identRe = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(stripped)) !== null) {
    const name = m[0];
    const before = stripped.slice(Math.max(0, m.index - 2), m.index);
    const after = stripped.slice(m.index + name.length).match(/^\s*:/);
    if (/[.?]$/.test(before) && before !== ' ?.') continue; // .x / ?.x（无空格形态）
    if (/\.\s*$/.test(before) || /\?\.$/.test(before)) continue;
    if (after) continue; // 对象字面量 key（漏报方向：三元分支中段也误跳——可容忍）
    if (LEXER_KEYWORDS.has(name) || LEXER_GLOBALS.has(name) || bound.has(name)) continue;
    free.add(name);
  }
  return [...free].slice(0, 5);
}

/**
 * import/require 预检（实测复盘 4cd1a90d：旧正则 /\b(?:import|require)\s*\(?
 * 连字符串字面量与注释一起杀——模型把 node -e 命令文本写进 pwsh 参数、
 * 注释里提到 require 一词均被拒，四连败后被迫放弃验证路径）。
 *
 * 判定收窄到真模块语义：
 *   ① 静态 import——行首（含缩进）import …（from 'x' / 'x' / type）；
 *   ② 动态 require 调用——require('x' | "x") 字面量参数形态；
 *   ③ 动态 import 调用——同上。
 * 字符串/模板字面量/注释中出现的词不再命中（排除法：剥掉再测）。
 * 恶意拼装（eval('req'+'uire')…）本就不防——containment 边界在工具桥，
 * 预检是防呆不是安全边界（worker 头注释口径）。
 */
export function findBannedModuleSyntax(code: string): string | undefined {
  // 剥除注释与字符串/模板字面量后再匹配——只测「代码」
  let stripped = '';
  const rejectedAt = (kind: string, index: number): string =>
    `程序体不允许 ${kind}（工具调用经 tools.* 桥接）——命中位置：${snippetAt(code, index)}`;
  for (let i = 0; i < code.length; ) {
    const rest = code.slice(i);
    // 行注释 / 块注释
    if (rest.startsWith('//')) {
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl;
      stripped += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = code.indexOf('*/', i + 2);
      const end = close === -1 ? code.length : close + 2;
      stripped += ' '.repeat(end - i);
      i = end;
      continue;
    }
    // 字符串 / 模板字面量（保守：不解析模板内插值——${…} 里的代码
    // 一并跳过；插值中写 require('x') 属拼装规避，不在防呆面内）。
    // 掩蔽保留首尾引号、只抹内容（等长）：调用检测正则要看到
    // require('…') 的引号才能命中——全抹成空格会让 require('node:fs')
    // 漏检（实测：动态 import('node:fs') 曾因此在 worker 里真跑通）
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === quote) { j += 1; break; }
        j += 1;
      }
      const closed = j - i >= 2 && code[j - 1] === quote;
      stripped += quote + ' '.repeat(Math.max(0, j - i - (closed ? 2 : 1))) + (closed ? quote : '');
      i = j;
      continue;
    }
    stripped += code[i];
    i += 1;
  }
  // ① 静态 import：行首 import（模块语法在函数体内非法，但 strip 前
  // 源文本可判；strip 后模块语义会导致 new Function 编译错，预检给出
  // 更友好的报错）
  const importRe = /^[ \t]*import[\s{*'"]/m;
  const importMatch = importRe.exec(stripped);
  if (importMatch) {
    return rejectedAt('import 语法', importMatch.index);
  }
  // ② require('x') / ③ import('x')——带字面量参数的调用形态
  const callRe = /\b(?:require|import)\s*\(\s*['"]/g;
  const callMatch = callRe.exec(stripped);
  if (callMatch) {
    return rejectedAt(callMatch[0].startsWith('require') ? 'require() 调用' : 'import() 调用', callMatch.index);
  }
  return undefined;
}

/** 命中位置前后各 ~30 字符的源文本预览（错误信息可定位） */
export function snippetAt(code: string, index: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(code.length, index + 40);
  return `…${code.slice(start, end).replace(/\s+/g, ' ')}…`;
}

/**
 * 单/双引号字符串字面量内嵌真实换行符的确定性归一。
 *
 * JS 禁止普通字符串内裸换行（换行即字面量终止、后续是垃圾 token）；
 * shell/Python 语感漂移下高频出现，此前直接进 strip 报
 * 「Invalid or unexpected token（仅行号）」——不点病因，模型无从自修。
 * 与 # → //（cr-59）同族：写法漂移的确定性救活，语义还原作者本意
 * （跨行文本 = \n 换行的字符串）。
 *
 * 机制：走查共享词法骨架（注释/模板/正则整段跳过——与 normalizeHashComments
 * 同一判定单源）。骨架会把「遇换行仍不闭合的串」整段当区域吞掉，故引号字符
 * 由本函数先行拦截、做换行容错的配对扫描：
 * · 串内裸 LF / CRLF / CR → 确定性转义 \n（既有反斜杠转义对原样保留）；
 * · 无裸换行的合法串 → 原样跳过（合法程序字节零触碰）；
 * · 无配对终止符（到 EOI 未闭合）→ 原样透传，strip 报准确的 unterminated。
 * 已知边界：模板串插值段内的漂移串不归一（骨架把整个模板作单区域跳过、
 * 插值内文本零触碰——沿用 cr-59 口径）。
 */
export function normalizeStringNewlines(src: string): string {
  let out = '';
  let pos = 0;
  let i = 0;
  while (i < src.length) {
    const q = src[i];
    if (q === '"' || q === "'") {
      // 换行容错扫描：找配对终止符（反斜杠转义跳过；换行不终止——
      // 合法串不会在闭合前遇换行，遇到即为漂移形态）
      let j = i + 1;
      let sawNl = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === q) break;
        if (d === '\n' || d === '\r') sawNl = true;
        j += 1;
      }
      if (j < src.length && sawNl) {
        // (i, j) 为含裸换行的串字面量整体：串体换行转义重写
        let body = '';
        for (let t = i + 1; t < j; t++) {
          const e = src[t];
          if (e === '\\') { body += e + (src[t + 1] ?? ''); t += 1; continue; }
          if (e === '\r') { if (src[t + 1] === '\n') t += 1; body += '\\n'; continue; }
          if (e === '\n') { body += '\\n'; continue; }
          body += e;
        }
        out += src.slice(pos, i) + q + body + src[j];
        pos = j + 1;
        i = j + 1;
        continue;
      }
      // 合法串（无裸换行）跳到闭合符后；未闭合（j 到 EOI）单步前进透传
      if (j < src.length) { i = j + 1; continue; }
      i += 1;
      continue;
    }
    const end = lexicalRegionEnd(src, i);
    i = end > i ? end : i + 1;
  }
  return pos === 0 ? src : out + src.slice(pos);
}

/**
 * 擦除前总归一：# 注释 + 字符串裸换行（cr-59 + 本次扩展）。
 * 幂等：归一只重写确定性字面量区域，重复调用字节不变。
 */
export function normalizeSource(src: string): string {
  return normalizeStringNewlines(normalizeHashComments(src));
}
