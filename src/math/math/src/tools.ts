// ============================================================
// src/plugins/builtin-math/tools.ts —— 数学工具（node:vm 沙箱求值）
//
// 单个通用 math 工具：接收表达式字符串，用 node:vm 沙箱求值。
// 零 npm 依赖（不用 mathjs），仅用 Node 内置 vm + Math 白名单。
//
// 安全设计：
//   · vm.createContext 隔离全局 —— 表达式看不到 process/require/globalThis
//   · 注入白名单：Math/JSON/Number/BigInt/Infinity/NaN/parseFloat/parseInt/isNaN
//   · timeout 兜底防死循环
//
// 用法：expression "1+2*3" → 7；"sqrt(16)" → 4；"2**10" → 1024；"sin(pi/2)" → 1
// （常用 Math 函数已全局化：sqrt/pow/sin/cos/... 无需 Math. 前缀；常量 PI/E）
//
// 依赖方向：仅依赖 @core/types + Node 内置 vm。
// ============================================================

import * as vm from 'vm';
import type { Tool } from '@agentchat/agent-loop';
import { defineTool } from '@agentchat/toolkit';

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
  for (const name of ['sqrt', 'pow', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'sin', 'cos', 'tan', 'log', 'log2', 'log10', 'exp', 'trunc', 'sign', 'cbrt', 'hypot', 'random'] as const) {
    s[name] = (Math as any)[name];
  }
  return s;
}

/** 在 vm 沙箱中求值表达式（返回字符串结果） */
function evaluateExpression(expression: string): { ok: true; value: string } | { ok: false; message: string } {
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
    if (result === undefined) return { ok: false, message: '表达式无返回值（请确保以表达式结尾，不要用分号/语句）' };
    return { ok: true, value: String(result) };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? String(err) };
  }
}

/** 数学工具（单个通用表达式求值，node:vm 沙箱） */
export const mathTools: Tool[] = [
  defineTool({
    name: 'math', label: '数学', requires: ['agent'],
    description: '计算数学表达式（沙箱求值，比 bash 更安全）。支持 + - * / % ** ( )，以及常用函数（无需 Math. 前缀）：sqrt/pow/abs/floor/ceil/round/min/max/sin/cos/tan/log/log2/log10/exp/trunc/cbrt/hypot，常量 PI/E。示例：1+2*3 → 7；sqrt(16) → 4；2**10 → 1024；sin(PI/2) → 1。需要数值计算结果时优先用它。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式（JS 语法，可用 Math.* 函数与常量）' },
      },
      required: ['expression'],
    },
    extractLabel: (args) => String(args.expression || ''),
    execute: async ({ expression }) => {
      const expr = String(expression ?? '').trim();
      if (!expr) return JSON.stringify({ status: 'error', data: { message: '缺少 expression 参数' } });
      const r = evaluateExpression(expr);
      if (!r.ok) return JSON.stringify({ status: 'error', data: { expression: expr, message: r.message } });
      return JSON.stringify({ status: 'ok', data: { expression: expr, result: r.value } });
    },
  }),
];

