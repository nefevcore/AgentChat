// ============================================================
// ac-edit-core/src/syntax-check.ts —— 写回前轻量语法预检（fail-fast）
//
// 事故背景（docs/edit-tool-incident-report.md §2.3）：替换后的内容不经
// 任何语法检查直接写回——TS 文件 interface 未闭合一类结构损坏要到下一轮
// typecheck 才暴露，而那时调用方已基于损坏文件继续编辑，连环二次破坏。
// 本模块按扩展名做 O(n) 级校验，失败即拒绝写回、文件保持原状。
//
// 范围（刻意轻量）：
//   .json  → JSON.parse 严格校验
//   .jsonc → 剥注释后 JSON.parse
//   .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts/.vue/.css/.scss → 括号配平
//   其余   → 不校验（返回 null 放行）
//
// 括号配平是字符串/模板/注释/正则感知的单遍状态机。启发式有已知盲区
//（关键字后正则、跨行字符串等），但系统性误判会同时影响编辑前后两次
// 扫描——pairedCheck 的基线比对使其自然放行；真实新增的配平破坏则会被
// 拦下。文件编辑前已是损坏态时同样放行（修复编辑不该被旧伤锁死）。
// ============================================================

/** 语法预检结果：null = 放行（无校验 / 通过 / 判定修复编辑） */
export interface SyntaxCheckResult {
  /** 拒绝原因（调用方原样转成编辑错误） */
  reason: string;
}

const PAIRED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.css', '.scss',
]);

/**
 * 写回前语法预检。返回 null 放行写回；返回 reason 则拒绝编辑、文件保持原状。
 */
export function syntaxCheckBeforeWrite(
  filePath: string,
  before: string,
  after: string,
): SyntaxCheckResult | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  if (ext === '.json' || ext === '.jsonc') {
    const r = ext === '.json' ? jsonCheck(after) : jsonCheck(stripJsonComments(after));
    if (r === null) return null;
    // 基线也解析失败 → 判定修复编辑，放行（与配平预检同语义）
    const beforeR = ext === '.json' ? jsonCheck(before) : jsonCheck(stripJsonComments(before));
    return beforeR !== null ? null : r;
  }
  if (PAIRED_EXTS.has(ext)) return pairedCheck(before, after);
  return null;
}

// ============================================================
// JSON / JSONC
// ============================================================

function jsonCheck(content: string): SyntaxCheckResult | null {
  if (content.trim().length === 0) return null; // 空文件视为待写状态，放行
  try {
    JSON.parse(content);
    return null;
  } catch (e) {
    return { reason: `JSON 解析失败（${e instanceof Error ? e.message : String(e)}）。` };
  }
}

/** 剥 // 与块注释（保留字符串字面量内的注释符） */
function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, text.length);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ============================================================
// 括号配平（字符串/模板/注释/正则感知的单遍状态机）
// ============================================================

/**
 * 栈项：'(' | '[' | '{' —— 普通括号；'T' —— 模板字面量内部；
 * 'P' —— 模板 ${ 占位符表达式（其内的 } 闭合占位符而非普通花括号）。
 * 栈元素带开启下标（{ ch, pos }）——报错时换算成「第 N 行第 C 列 + 行预览」，
 * 裸字符下标（如「位置 124732」）对人与模型均不可读。
 */
type StackEntry = '(' | '[' | '{' | 'T' | 'P';

/** 配平扫描：返回带「行号 + 行预览」定位的错误描述（null = 配平） */
function pairedScan(content: string): string | null {
  const stack: Array<{ ch: StackEntry; pos: number }> = [];
  let inTemplate = false; // 当前在模板内部（只认 ` ${ \）
  let prev = ''; // 上一个有意义字符（正则/除号判定）

  let i = 0;
  while (i < content.length) {
    const c = content[i];

    if (inTemplate) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        if (stack.pop()?.ch !== 'T') return `${locate(content, i)}：模板字面量闭合错配`;
        inTemplate = false;
        prev = '`';
        i++;
        continue;
      }
      if (c === '$' && content[i + 1] === '{') {
        stack.push({ ch: 'P', pos: i }); // 占位符表达式按代码扫描
        inTemplate = false;
        prev = '{';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // —— 代码模式 ——
    if (c === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue; // '\n' 留给主循环按空白处理
    }
    if (c === '/' && content[i + 1] === '*') {
      i += 2;
      while (i + 1 < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i = Math.min(i + 2, content.length);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(content, i, c);
      prev = '"';
      continue;
    }
    if (c === '`') {
      stack.push({ ch: 'T', pos: i });
      inTemplate = true;
      i++;
      continue;
    }
    if (c === '/' && isRegexStart(prev)) {
      i = skipRegex(content, i);
      prev = '/';
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      stack.push({ ch: c, pos: i });
    } else if (c === ')' || c === ']') {
      const top = stack.pop();
      if (!top || top.ch !== (c === ')' ? '(' : '[')) {
        return top === undefined
          ? `${locate(content, i)}：'${c}' 无对应开括号`
          : `${locate(content, i)}：'${c}' 与 ${describeStackTop(top.ch)} 不配对`;
      }
    } else if (c === '}') {
      const top = stack.pop();
      if (top?.ch === 'P') {
        inTemplate = true; // 占位符结束 → 回模板内部
      } else if (top?.ch === '{') {
        // 正常闭合
      } else if (top === undefined) {
        return `${locate(content, i)}：'}' 无对应开括号`;
      } else {
        return `${locate(content, i)}：'}' 与 ${describeStackTop(top.ch)} 不配对`;
      }
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return top.ch === 'T'
      ? `${locate(content, top.pos)}：模板字面量未闭合`
      : `${locate(content, top.pos)}：${describeStackTop(top.ch)} 未闭合（其后直至文件结尾未见配对闭括号）`;
  }
  return null;
}

/** 栈记号进报错文案的人话形态（'T'/'P' 是内部记号，不能裸进消息） */
function describeStackTop(ch: StackEntry): string {
  if (ch === 'T') return '模板字面量 `';
  if (ch === 'P') return '模板占位符 ${';
  return `'${ch}'`;
}

/** 字符下标 → 「第 N 行第 C 列（该行内容预览）」；行号与 read 工具同口径（1 起） */
function locate(content: string, pos: number): string {
  let line = 1;
  let lineStart = 0;
  for (let j = 0; j < pos && j < content.length; j++) {
    if (content[j] === '\n') {
      line++;
      lineStart = j + 1;
    }
  }
  let lineEnd = content.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  const text = content.slice(lineStart, lineEnd).trim();
  const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  const at = `第 ${line} 行第 ${pos - lineStart + 1} 列`;
  return preview ? `${at}（${preview}）` : at;
}

/** 正则判定启发式：前一有意义字符是操作数结尾（标识符/右括号/引号）→ 除号 */
function isRegexStart(prev: string): boolean {
  if (!prev) return true; // 文件开头
  return !/[\w$)\]'"`]/.test(prev);
}

/** 跳过字符串字面量，返回下一个待处理位置（闭合引号之后） */
function skipQuoted(content: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i; // 未闭合：按行止（宽松），'\n' 留给主循环
    i++;
  }
  return i;
}

/** 跳过正则字面量（含字符类），返回下一个待处理位置 */
function skipRegex(content: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return i; // 跨行按未闭合正则宽松处理
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      return i + 1;
    }
    i++;
  }
  return i;
}

/** 配平类扩展名：编辑后配平失败 + 基线通过 → 拒绝；基线也失败 → 判修复编辑放行 */
function pairedCheck(before: string, after: string): SyntaxCheckResult | null {
  const err = pairedScan(after);
  if (err === null) return null;
  if (pairedScan(before) !== null) return null; // 编辑前已损坏：放行修复编辑
  return {
    reason:
      `括号配平预检失败：${err}。` +
      `行号按编辑后内容计（未写盘，现盘文件保持原状）；old_string 可能匹配错位。`,
  };
}
