// ============================================================
// list_subagents 工具 —— 查看活跃子 Agent 状态
//
// 用途：父 Agent 检查自己 spawn 的子 Agent 运行状态，
//       确认哪些已完成、哪些仍在运行、哪些异常。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getSubAgentManager } from '@plugins/builtin/src/sub-agent';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'list_subagents',
      description:
        '列出所有活跃子 Agent 及其状态（running/done/error/timeout/killed）。用于查看已生成子任务的处理进度。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  extractLabel: () => '📋',

  execute: async () => {
    try {
      const manager = getSubAgentManager();
      const list = manager.list().map(h => ({
        id: h.id,
        parent: h.parentId,
        name: h.name,
        status: h.status,
        task: h.task.slice(0, 80),
        started_at: new Date(h.startedAt).toLocaleTimeString('zh-CN'),
        elapsed_ms: (h.finishedAt ?? Date.now()) - h.startedAt,
      }));

      return JSON.stringify({
        status: 'ok',
        data: {
          active_count: list.length,
          subagents: list,
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
    }
  },
};
