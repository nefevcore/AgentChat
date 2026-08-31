// ============================================================
// ac-math/src/index.ts —— 数学工具行（纯表达式解析求值）
//
// A2 加固（2026-08-31 审计）：node:vm 求值已被移除——宿主对象按引用注入
// vm context 即构造器链逃逸（Math.constructor.constructor("return
// process")()，实测），且 Promise 微任务可冻结宿主事件循环。vm 沙箱对
// 敌意输入不构成安全边界，本工具面对的是提示注入可达面（math 注册无
// requiredTags，一切 Agent 含默认预设可调）。
//
// 现实现 = 自写 tokenizer + 递归下降求值器（零 npm 依赖、零宿主对象
// 注入面）：只认数字字面量（含 0x/0b/0o/BigInt n 后缀）、白名单常量与
// 函数、四则/取模/幂/一元正负、括号与逗号。赋值/成员链/字符串/箭头
// 函数/语句一律解析失败；标识符白名单外即报错（process/require/
// globalThis 天然不可见——不是"看不见"，是语法上不存在）。
//
// 资源护栏：表达式长度、token 数、嵌套深度、BigInt 幂指数上限（防
// 巨数内存炸弹）；求值为同步纯计算，无可挂死面。
// ============================================================
import type { Context } from '@agentchat/cordis';

/** 求值器资源护栏 */
const MAX_EXPR_LENGTH = 2000;
const MAX_TOKENS = 4000;
const MAX_DEPTH = 200;
const MAX_BIGINT_EXPONENT = 65_536n;

/** 求值错误（message 面向模型可读） */
class MathError extends Error {}

type Token =
  | { kind: 'num'; value: number | bigint }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'end' };

/** 白名单常量（裸名与 Math. 前缀共用一张表） */
const CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  Infinity: Infinity,
  NaN: NaN,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
};

/** 白名单函数（Math.* 同名成员 + 全局化短名）；BigInt 实参按 JS 语义转 Number */
const FUNCTION_NAMES = [
  'sqrt', 'pow', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'sin', 'cos',
  'tan', 'asin', 'acos', 'atan', 'atan2', 'log', 'log2', 'log10', 'exp',
  'trunc', 'sign', 'cbrt', 'hypot', 'random',
] as const;

const FUNCTIONS: Record<string, (...args: number[]) => number> = Object.fromEntries(
  FUNCTION_NAMES.map((name) => [name, (Math as unknown as Record<string, (...a: number[]) => number>)[name]]),
);

function isFunctionName(name: string): name is (typeof FUNCTION_NAMES)[number] {
  return name in FUNCTIONS;
}

/** BigInt 实参 → Math 函数数值参数（JS 隐式转换语义显式化；超安全整数精度自担） */
function toNumber(v: number | bigint): number {
  if (typeof v === 'number') return v;
  return Number(v);
}

// ---- tokenizer ----

const OPERATORS = ['**', '+', '-', '*', '/', '%', '(', ')', ',', '.'] as const;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // 数字字面量：0x/0b/0o 前缀或十进制（含 .5 / 1e3 / 123n BigInt）
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const rest = input.slice(i);
      let value: number | bigint;
      let length: number;
      const radix = /^0[xX][0-9a-fA-F_]+n?|^0[bB][01_]+n?|^0[oO][0-7_]+n?/.exec(rest);
      const decimal = /^(?:[0-9][0-9_]*)?\.?[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?n?|^[0-9][0-9_]*n/.exec(rest);
      if (radix) {
        const text = radix[0];
        length = text.length;
        const body = text.replace(/n$/, '').replace(/_/g, ''); // '0x1F' 形
        value = text.endsWith('n') ? BigInt(body) : parseInt(body.slice(2), body[1] === 'x' || body[1] === 'X' ? 16 : body[1] === 'b' || body[1] === 'B' ? 2 : 8);
      } else if (decimal) {
        const text = decimal[0].replace(/_/g, '');
        length = decimal[0].length;
        if (text.endsWith('n')) {
          const digits = text.slice(0, -1);
          if (!/^\d+$/.test(digits)) throw new MathError(`BigInt 字面量须为整数: ${text}`);
          value = BigInt(digits);
        } else {
          value = Number(text);
          if (Number.isNaN(value)) throw new MathError(`数字字面量无法解析: ${text}`);
        }
      } else {
        throw new MathError(`数字字面量无法解析: ${rest.slice(0, 12)}`);
      }
      tokens.push({ kind: 'num', value });
      i += length;
      if (tokens.length > MAX_TOKENS) throw new MathError('表达式过长（token 数超限）');
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(input.slice(i))!;
      tokens.push({ kind: 'ident', name: m[0] });
      i += m[0].length;
      if (tokens.length > MAX_TOKENS) throw new MathError('表达式过长（token 数超限）');
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '**') {
      tokens.push({ kind: 'op', op: '**' });
      i += 2;
      continue;
    }
    if ((OPERATORS as readonly string[]).includes(ch)) {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }
    throw new MathError(`无法识别的字符 "${ch}"（本工具只支持纯数学表达式：数字/四则/幂/取模/白名单函数与常量）`);
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

// ---- 递归下降求值器 ----

class Evaluator {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens; // 显式赋值——参数属性不被 Node 原生 TS strip-only 加载器支持
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectOp(op: string): void {
    const t = this.next();
    if (t.kind !== 'op' || t.op !== op) throw new MathError(`期待 "${op}"，收到 ${describe(t)}`);
  }

  /** entry：expression := additive */
  evaluate(): number | bigint {
    const v = this.additive(0);
    const t = this.peek();
    if (t.kind !== 'end') throw new MathError(`表达式末尾有多余内容: ${describe(t)}`);
    return v;
  }

  /** additive := multiplicative (('+'|'-') multiplicative)* */
  private additive(depth: number): number | bigint {
    this.enter(depth);
    let left = this.multiplicative(depth + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.next();
        const right = this.multiplicative(depth + 1);
        left = t.op === '+' ? this.add(left, right) : this.sub(left, right);
      } else {
        return left;
      }
    }
  }

  /** multiplicative := unary (('*'|'/'|'%') unary)* */
  private multiplicative(depth: number): number | bigint {
    this.enter(depth);
    let left = this.unary(depth + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind === 'op' && (t.op === '*' || t.op === '/' || t.op === '%')) {
        this.next();
        const right = this.unary(depth + 1);
        if (t.op === '*') left = this.mul(left, right);
        else if (t.op === '/') left = this.div(left, right);
        else left = this.mod(left, right);
      } else {
        return left;
      }
    }
  }

  /** unary := ('+'|'-') unary | power（幂右结合；一元负号先于幂结合时按 -(a**b) 宽容处理） */
  private unary(depth: number): number | bigint {
    this.enter(depth);
    const t = this.peek();
    if (t.kind === 'op' && (t.op === '-' || t.op === '+')) {
      this.next();
      const v = this.unary(depth + 1);
      return t.op === '-' ? this.neg(v) : v;
    }
    return this.power(depth + 1);
  }

  /** power := primary ('**' unary)? */
  private power(depth: number): number | bigint {
    this.enter(depth);
    const base = this.primary(depth + 1);
    const t = this.peek();
    if (t.kind === 'op' && t.op === '**') {
      this.next();
      const exp = this.unary(depth + 1);
      return this.pow(base, exp);
    }
    return base;
  }

  /** primary := number | ident | ident '(' args ')' | 'Math' '.' (ident | ident '(' args ')') | '(' additive ')' */
  private primary(depth: number): number | bigint {
    this.enter(depth);
    const t = this.next();
    if (t.kind === 'num') return t.value;
    if (t.kind === 'op' && t.op === '(') {
      const v = this.additive(depth + 1);
      this.expectOp(')');
      return v;
    }
    if (t.kind === 'ident') {
      // Math. 前缀：仅放行常量/函数成员，其余成员链一律拒绝
      const dot = this.peek();
      if (dot.kind === 'op' && dot.op === '.') {
        if (t.name !== 'Math') throw new MathError(`不允许访问 "${t.name}" 的成员（仅支持 Math. 前缀）`);
        this.next();
        const member = this.next();
        if (member.kind !== 'ident') throw new MathError(`Math. 后期待名称，收到 ${describe(member)}`);
        return this.named(member.name, depth + 1);
      }
      return this.named(t.name, depth + 1);
    }
    throw new MathError(`期待数字/标识符/左括号，收到 ${describe(t)}`);
  }

  /** 具名常量或函数调用 */
  private named(name: string, depth: number): number | bigint {
    if (name in CONSTANTS) {
      if (this.isCall()) throw new MathError(`"${name}" 是常量，不是函数`);
      return CONSTANTS[name]!;
    }
    if (isFunctionName(name)) return this.call(name, depth);
    throw new MathError(
      `未知标识符 "${name}"（可用：四则/幂/取模运算，常量 ${Object.keys(CONSTANTS).join('/')}，`
        + `函数 ${[...FUNCTION_NAMES].join('/')}，以及 Math. 前缀同名成员；其他 JS 语法不支持）`,
    );
  }

  private isCall(): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.op === '(';
  }

  private call(name: string, depth: number): number | bigint {
    this.expectOp('(');
    const args: Array<number | bigint> = [];
    const first = this.peek();
    if (!(first.kind === 'op' && first.op === ')')) {
      for (;;) {
        args.push(this.additive(depth + 1));
        if (args.length > 64) throw new MathError('函数实参数过多（上限 64）');
        const t = this.next();
        if (t.kind === 'op' && t.op === ',') continue;
        if (t.kind === 'op' && t.op === ')') break;
        throw new MathError(`函数实参列表期待 "," 或 ")"，收到 ${describe(t)}`);
      }
    } else {
      this.next();
    }
    const fn = FUNCTIONS[name]!;
    return fn(...args.map(toNumber));
  }

  private enter(depth: number): void {
    if (depth > MAX_DEPTH) throw new MathError(`表达式嵌套过深（上限 ${MAX_DEPTH}）`);
  }

  // ---- 混合运算（JS 语义：BigInt 与 Number 混用即报错） ----

  private add(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === 'bigint' && typeof b === 'bigint') return a + b;
    if (typeof a === 'bigint' || typeof b === 'bigint') throw mixedError('+');
    return a + b;
  }

  private sub(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === 'bigint' && typeof b === 'bigint') return a - b;
    if (typeof a === 'bigint' || typeof b === 'bigint') throw mixedError('-');
    return a - b;
  }

  private mul(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === 'bigint' && typeof b === 'bigint') return a * b;
    if (typeof a === 'bigint' || typeof b === 'bigint') throw mixedError('*');
    return a * b;
  }

  private div(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      if (b === 0n) throw new MathError('BigInt 除以零');
      return a / b;
    }
    if (typeof a === 'bigint' || typeof b === 'bigint') throw mixedError('/');
    return a / b;
  }

  private mod(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      if (b === 0n) throw new MathError('BigInt 取模零');
      return a % b;
    }
    if (typeof a === 'bigint' || typeof b === 'bigint') throw mixedError('%');
    return a % b;
  }

  private pow(a: number | bigint, b: number | bigint): number | bigint {
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      if (b < 0n) throw new MathError('BigInt 幂指数不能为负（JS 同语义）');
      if (b > MAX_BIGINT_EXPONENT) throw new MathError(`BigInt 幂指数过大（上限 ${MAX_BIGINT_EXPONENT}）`);
      return a ** b;
    }
    if (typeof a === 'bigint' || typeof b === 'bigint') throw mixedError('**');
    return a ** b;
  }

  private neg(v: number | bigint): number | bigint {
    return -v; // 一元负号对 number/bigint 均原生有效
  }
}

function mixedError(op: string): MathError {
  return new MathError(`BigInt 与普通数字不能直接 ${op} 混算（请统一类型，如 Number(10n) 或 BigInt(10) 形式改写表达式）`);
}

function describe(t: Token): string {
  if (t.kind === 'end') return '表达式结尾';
  if (t.kind === 'num') return `数字 ${String(t.value)}`;
  if (t.kind === 'ident') return `标识符 "${t.name}"`;
  return `"${t.op}"`;
}

/** 解析并求值纯数学表达式（返回字符串结果；非 JS 求值——零宿主对象面） */
export function evaluateExpression(
  expression: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (expression.length > MAX_EXPR_LENGTH) {
    return { ok: false, message: `表达式过长（上限 ${MAX_EXPR_LENGTH} 字符）` };
  }
  try {
    const result = new Evaluator(tokenize(expression)).evaluate();
    if (typeof result === 'number') {
      // 浮点精度归一化（0.1+0.2 → 0.3）
      const v = Math.abs(result) < 1e-12 ? 0 : Number(result.toPrecision(15));
      return { ok: true, value: String(v) };
    }
    return { ok: true, value: result.toString() };
  } catch (err: unknown) {
    // MathError 与意外异常同形收敛（都是可读 message）
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const name = 'ac-math';

export const inject = ['tools'];

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'math',
    description: '计算数学表达式（如 "1+2*3"、"sqrt(16)"、"(1+2**10)/4"、"10n**21n"；纯数学语法解析求值，非 JS 执行）。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式（四则/幂/取模 + Math 函数与常量）' },
      },
      required: ['expression'],
    },
    execute(args) {
      const expr = String(args.expression ?? '').trim();
      if (!expr) return { ok: false, error: '缺少 expression 参数' };
      const r = evaluateExpression(expr);
      if (!r.ok) return { ok: false, error: r.message, output: { expression: expr } };
      return { ok: true, output: { expression: expr, result: r.value } };
    },
  });
}
