// ============================================================
// kill_subagent 工具 —— 中断并回收子 Agent
//
// 参数：
//   subagent_id – 要终止的子 Agent ID
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getSubAgentManager } from '@plugins/builtin/src/sub-agent';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'kill_subagent',
      description:
        '中断并回收运行中的子 Agent，释放其 token 预算。用于子任务不再需要或卡住时。',
      parameters: {
        type: 'object',
        properties: {
          subagent_id: { type: 'string', description: '要终止的子 Agent ID' },
        },
        required: ['subagent_id'],
      },
    },
  },

  extractLabel: (args: Record<string, any>) => `✕ 终止: ${args.subagent_id || '?'}`,

  execute: async (args: Record<string, any>) => {
    try {
      const id = String(args.subagent_id ?? '');
      if (!id) {
        return JSON.stringify({ status: 'error', data: { message: '缺少 subagent_id 参数' } });
      }
      const manager = getSubAgentManager();
      const ok = manager.kill(id);
      if (!ok) {
        return JSON.stringify({ status: 'error', data: { message: `子 Agent "${id}" 不存在或已回收` } });
      }
      return JSON.stringify({
        status: 'ok',
        data: { subagent_id: id, message: `子 Agent "${id}" 已终止并回收` },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
    }
  },
};
