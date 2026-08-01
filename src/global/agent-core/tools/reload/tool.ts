// ============================================================
// reload 工具 —— 统一热加载（v0.4.0 合并 reload_self_tools + reload_extensions）
//
// scope:
//   self   重载当前 Agent 的 tools/（自举工具开发）
//   global 重载全局扩展（PreHook/PostHook/Interceptor）+ 全局工具
//   all    两者都做（默认）
//
// 旧工具 reload_self_tools / reload_extensions 保留为别名（内部转发到此工具）。
//
// 语义化中断（v0.4.2）：不再直接执行重载，而是抛出 ToolInterrupt('reload-requested')。
// Agent 的 run() 会先走 postHook（消息落盘）再执行 performReload，然后 reinit 继续推理。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { ToolInterrupt } from '@core/interrupt';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'reload',
      description:
        '热加载工具与扩展。scope=self 重载自己的 tools/ 目录（创建新工具后调用即可用）；scope=global 重载全局扩展与全局工具（修改 src/global/agent-core/ 后调用，所有 Agent 生效）；scope=all 两者都做（默认）。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string', enum: ['self', 'global', 'all'],
            description: '重载范围（默认 all）',
          },
        },
        required: [],
      },
    },
  },

  extractLabel: (args: Record<string, any>) => `⟳ ${args.scope || 'all'}`,

  execute: async (args: Record<string, any>): Promise<string> => {
    const scope = (args.scope || 'all') as 'self' | 'global' | 'all';
    // 语义化中断：不在此处直接执行，由 Agent run() 收尾后调用 performReload
    throw new ToolInterrupt({ type: 'reload-requested', scope });
  },
};
