// ============================================================
// disable_timer 工具 —— 禁用 Agent 的定时任务（不删除）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { timerManager } from '@plugins/builtin/src/timer';

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'disable_timer',
      description:
        '禁用指定定时任务（不删除，可通过 set_timer 重新启用）。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent ID（自动注入）' },
          id: { type: 'string', description: '任务 ID（通过 list_timers 查看）' },
        },
        required: ['id'],
      },
    },
  },
  ...meta,

  execute: async (args: Record<string, any>) => {
    const agentId = args.agent_id || args.from;
    if (!agentId) return '[disable_timer] 错误：无法确定 Agent ID';
    const id = args.id;
    if (!id) return '[disable_timer] 错误：缺少 id 参数';

    const entries = timerManager.getEntries(agentId);
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) {
      return `[disable_timer] 未找到任务 "${id}"。可用：${entries.map(e => e.id).join(', ') || '(无)'}`;
    }

    entries[idx] = { ...entries[idx], enabled: false };
    timerManager.saveEntries(agentId, entries);
    return `定时任务 "${id}" 已禁用。可通过 set_timer 重新启用。`;
  },
};
