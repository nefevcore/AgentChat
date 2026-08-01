// ============================================================
// await_subagent 工具 —— 等待子 Agent 完成并获取结果
//
// 参数：
//   subagent_id – spawn_subagent 返回的 ID（必填）
//   wait_s      – 等待秒数（默认 60s；超时任务仍在后台，可再次调用）
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getSubAgentManager } from '@core/sub-agent';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'await_subagent',
      description:
        'Wait for a sub-agent to finish and return its result. Use the subagent_id returned by spawn_subagent. Returns status: running/done/error/timeout/killed.',
      parameters: {
        type: 'object',
        properties: {
          subagent_id: { type: 'string', description: '子 Agent ID（spawn_subagent 返回）' },
          wait_s: { type: 'number', description: '等待秒数（默认 60；超时任务仍在后台，可再次调用）' },
        },
        required: ['subagent_id'],
      },
    },
  },

  extractLabel: (args: Record<string, any>) => `⌛ ${args.subagent_id || '?'}`,

  execute: async (args: Record<string, any>) => {
    try {
      const id = String(args.subagent_id ?? '');
      if (!id) {
        return JSON.stringify({ status: 'error', data: { message: '缺少 subagent_id 参数' } });
      }

      const manager = getSubAgentManager();
      const waitMs = Math.round((Number(args.wait_s) || 60) * 1000);

      // 先查当前状态（可能已完成被回收）
      const cur = manager.get(id);
      if (!cur) {
        return JSON.stringify({
          status: 'error',
          data: { message: `子 Agent "${id}" 不存在或已回收（可能早已完成，结果已丢失）` },
        });
      }
      if (cur.status !== 'running') {
        return JSON.stringify({
          status: 'ok',
          data: {
            subagent_id: id,
            status: cur.status,
            result: cur.result,
            error: cur.error,
            elapsed_ms: (cur.finishedAt ?? Date.now()) - cur.startedAt,
          },
        });
      }

      // 等待完成
      const done = await manager.awaitResult(id, waitMs);
      if (!done) {
        return JSON.stringify({ status: 'error', data: { message: `子 Agent "${id}" 已消失` } });
      }
      if (done.status === 'running') {
        return JSON.stringify({
          status: 'ok',
          data: {
            subagent_id: id,
            status: 'running',
            message: `子 Agent 仍在运行（已等待 ${waitMs / 1000}s）。可再次调用 await_subagent 或 kill_subagent。`,
          },
        });
      }
      return JSON.stringify({
        status: 'ok',
        data: {
          subagent_id: id,
          status: done.status,
          result: done.result,
          error: done.error,
          elapsed_ms: (done.finishedAt ?? Date.now()) - done.startedAt,
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: err?.message ?? String(err) } });
    }
  },
};
