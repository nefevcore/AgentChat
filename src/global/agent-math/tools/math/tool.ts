// ============================================================
// math 工具 —— 数学表达式计算
// 基于 mathjs 封装，支持常用数学函数和运算符
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';

/** mathjs 实例的加载 Promise（启动时异步预热，首次调用无需等待 663ms import） */
let _mathPromise: Promise<{ evaluate: (expr: string) => any; format: (value: any, options?: any) => string }> | null = null;

function getMath() {
  if (!_mathPromise) {
    _mathPromise = (async () => {
      const { create, all } = await import('mathjs');
      const math = create(all);
      // 注册 ln 作为 log (自然对数) 的别名
      math.import({ ln: Math.log }, { override: true });
      return math;
    })();
  }
  return _mathPromise;
}

// 启动时异步预热：模块装配时立即开始后台加载 mathjs，
// 首次 execute 时通常已加载完成（0 等待），不阻塞启动。
void getMath();

/** 数学表达式计算工具，基于 mathjs 封装，支持常用数学函数和运算符 */
export const tool: Tool = {
  ...meta,
  extractLabel: (args) => args.expression || '',
  definition: {
    type: 'function',
    function: {
      name: 'math',
      description: '计算数学表达式，支持 +-*/^、三角函数、对数、平方根等。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 "1+2*3"、"sqrt(16)"、"sin(pi/2)"。',
          },
        },
        required: ['expression'],
      },
    },
  },

  async execute(args: Record<string, any>, stream): Promise<string> {
    const expression: string = args.expression;
    stream?.onChunk?.(`正在计算: ${expression}...\n`);

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
