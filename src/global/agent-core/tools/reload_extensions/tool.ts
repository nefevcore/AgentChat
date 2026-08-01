// ============================================================
// reload_extensions 工具 —— 热加载全局扩展/工具（别名，转发语义到 reload scope=global）
//
// 语义化中断（v0.4.2）：不再直接执行重载，抛出 ToolInterrupt('reload-requested', global)。
// 由 Agent run() 在 postHook 之后调用 performReload('global')，所有 Agent 生效。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { ToolInterrupt } from '@core/interrupt';

export const tool: Tool = {
  ...meta,
  definition: {
    type: 'function',
    function: {
      name: 'reload_extensions',
      description:
        '热加载全局扩展（PreHook/PostHook/Interceptor）和全局工具，如 agent-prompt、agent-session、agent-memory、read、edit 等。' +
        '修改了 src/global/agent-core/ 下的代码后调用此工具，所有 Agent 立即生效，无需重启。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },

  execute: async (_args: Record<string, any>): Promise<string> => {
    // 语义化中断：统一走 reload-requested(global)，由 run() 收尾后执行
    throw new ToolInterrupt({ type: 'reload-requested', scope: 'global' });
  },
};
