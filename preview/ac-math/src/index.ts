// ============================================================
// ac-math/src/index.ts —— 数学工具行（node:vm 沙箱求值）
//
// src math 平移（零 npm 依赖，输出归一 {ok, output}）。安全设计原样：
//   · vm.createContext 隔离全局——表达式看不到 process/require/globalThis
//   · 白名单注入：Math/JSON/Number/BigInt/Infinity/NaN/parseFloat/
//     parseInt/isNaN + 常用 Math 函数全局化（sqrt/pow/sin/...）+ 常量 PI/E
//   · timeout 兜底防死循环
// ============================================================
import * as vm from 'node:vm';
import type { Context } from '@agentchat/cordis';

/** 沙箱注入的白名单全局（表达式可见的最小集：Math 函数全局化 + 基础对象） */
function makeSandbox(): Record<string, unknown> {
  const s: Record<string, unknown> = {
    Math,
    JSON,
    Number,
    BigInt,
    Infinity,
    NaN,
    parseFloat,
    parseInt,
    isNaN,
    PI: Math.PI,
    E: Math.E,
  };
  // 常用 Math 函数全局化（兼容 sqrt(16) / sin(pi/2) 等无前缀写法）
  const fns = [
    'sqrt', 'pow', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'sin', 'cos',
    'tan', 'log', 'log2', 'log10', 'exp', 'trunc', 'sign', 'cbrt', 'hypot', 'random',
  ] as const;
  for (const name of fns) {
    s[name] = (Math as unknown as Record<string, unknown>)[name];
  }
  return s;
}

/** 在 vm 沙箱中求值表达式（返回字符串结果） */
export function evaluateExpression(
  expression: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  try {
    const result = vm.runInContext(expression, context, { timeout: 2000 });
    if (typeof result === 'number') {
      // 浮点精度归一化（0.1+0.2 → 0.3）
      const v = Math.abs(result) < 1e-12 ? 0 : Number(result.toPrecision(15));
      return { ok: true, value: String(v) };
    }
    if (typeof result === 'bigint') return { ok: true, value: result.toString() };
    if (result === undefined) {
      return { ok: false, message: '表达式无返回值（请确保以表达式结尾，不要用分号/语句）' };
    }
    return { ok: true, value: String(result) };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const name = 'ac-math';

export const inject = ['tools'];

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'math',
    description: '计算数学表达式（如 "1+2*3"、"sqrt(16)"、"(1+2**10)/4"；vm 沙箱求值）。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式' },
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
