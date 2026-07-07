// ============================================================
// math 工具 —— 数学表达式计算
// 基于 mathjs 封装，支持常用数学函数和运算符
// ============================================================

import { Tool } from '../../../core/types';

/** mathjs 实例（惰性初始化，注册 ln 别名） */
let _math: { evaluate: (expr: string) => any; format: (value: any, options?: any) => string } | null = null;

async function getMath() {
  if (_math) return _math;
  const { create, all } = await import('mathjs');
  const math = create(all);
  // 注册 ln 作为 log (自然对数) 的别名
  math.import({ ln: Math.log }, { override: true });
  _math = math;
  return math;
}

export const tool: Tool = {
  displayName: '数学',
  description: '数学工具',
  extractLabel: (args) => args.expression || '',
  definition: {
    type: 'function',
    function: {
      name: 'math',
      description: '数学工具',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '要计算的数学表达式，例如 "1 + 2 * 3"、"sqrt(16)"、"sin(pi/2)"。',
          },
        },
        required: ['expression'],
      },
    },
  },

  async execute(args: Record<string, any>): Promise<string> {
    const expression: string = args.expression;

    try {
      const math = await getMath();
      const result = math.evaluate(expression);
      // 格式化为精确数值字符串（避免浮点问题如 0.30000000000000004）
      const formatted = typeof result === 'number'
        ? math.format(result, { precision: 14 })
        : String(result);

      return JSON.stringify({
        status: 'success',
        data: {
          expression,
          result: formatted,
        },
      });
    } catch (err: any) {
      return JSON.stringify({
        status: 'error',
        data: {
          expression,
          message: err.message || String(err),
        },
      });
    }
  },
};
