// ============================================================
// list_timers 工具 —— 查询 Agent 的定时任务
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { timerManager } from '@plugins/builtin/src/timer';

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_timers',
      description:
        '查询当前 Agent 的所有定时任务（ID、状态、模式、时间/间隔、提示内容）。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Agent ID（自动注入）',
          },
        },
        required: [],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    const agentId = args.agent_id || args.from;
    if (!agentId) {
      return '[list_timers] 错误：无法确定 Agent ID';
    }
    const entries = timerManager.getEntries(agentId);
    if (entries.length === 0) {
      return `Agent "${agentId}" 没有配置定时任务。`;
    }
    const list = entries.map(e =>
      `- ${e.id} [${e.enabled ? '启用' : '禁用'}] ${e.mode === 'time' ? '定时 ' + (e.time || '?') : '延时 每' + (e.delay || '?')} × ${(e.repeatCount ?? 0) <= 0 ? '永久' : (e.repeatCount + '次')} -> ${e.target || 'user'}: ${e.hint}`
    ).join('\n');
    return `Agent "${agentId}" 的定时任务：\n${list}`;
  },
};
