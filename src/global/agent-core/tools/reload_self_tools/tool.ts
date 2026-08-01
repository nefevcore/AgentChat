// ============================================================
// reload_self_tools 工具 —— 热加载 Agent 自身 tools/（别名，转发语义到 reload scope=self）
//
// 语义化中断（v0.4.2）：不再直接执行重载，抛出 ToolInterrupt('reload-requested', self)。
// 由 Agent run() 在 postHook 之后调用 performReload('self')。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { ToolInterrupt } from '@core/interrupt';

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'reload_self_tools',
      description:
        '扫描当前 Agent 的 tools/ 目录，热加载新增或修改过的工具文件。' +
        '当你创建了新工具（通过 write/bash 写入 tools/ 下的 tool.ts）后，调用此工具即可立即使用新工具，无需重启。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: '要重载工具的 Agent ID（通常是你自己的 agent_id）',
          },
        },
        required: ['agent_id'],
      },
    },
  },
  ...meta,

  execute: async (_args: Record<string, any>): Promise<string> => {
    // 语义化中断：统一走 reload-requested(self)，由 run() 收尾后执行
    throw new ToolInterrupt({ type: 'reload-requested', scope: 'self' });
  },
};
