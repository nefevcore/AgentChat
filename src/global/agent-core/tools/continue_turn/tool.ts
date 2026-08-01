// ============================================================
// continue_turn 工具 —— 自我 steer：触发自己继续下一轮推理
//
// 场景：长回复被 LLM 输出截断、或推理需要继续深入时，
// Agent 调用本工具，当前回合结束后立即启动下一轮推理
// （基于同一会话上下文，不需要用户发新消息）。
//
// 实现：从 AppState.agents 取自己实例，调 agent.continueTurn()。
//   counterpart 缺省用当前对话的 sender（_conversationSender）。
//   hint 可选：注入为触发消息，引导下一轮方向。
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'continue_turn',
      description:
        'Continue your own reasoning for another turn in the current conversation (self-steer). Use when your reply was truncated, you need to go deeper, or you want to proactively start the next reasoning round without waiting for user input. Current turn finishes, then the next turn starts automatically with the same conversation context.',
      parameters: {
        type: 'object',
        properties: {
          hint: {
            type: 'string',
            description: 'Optional guidance for the next turn (injected as a trigger message). E.g. "continue the analysis from step 3", "summarize what was found".',
          },
          counterpart: {
            type: 'string',
            description: 'Conversation counterpart agent id (defaults to current conversation partner).',
          },
        },
      },
    },
  },

  extractLabel: () => '🔄 继续推理',

  execute: async (args: Record<string, any>): Promise<string> => {
    const from = args.from as string;
    if (!from) {
      return JSON.stringify({ status: 'error', data: { message: '无法确定调用方 Agent ID' } });
    }

    try {
      const state = getAppState() as any;
      const agents = state.agents as Map<string, any> | undefined;
      const self = agents?.get(from);
      if (!self || typeof self.continueTurn !== 'function') {
        return JSON.stringify({ status: 'error', data: { message: `Agent "${from}" 不可用或缺少 continueTurn 能力` } });
      }

      const hint = typeof args.hint === 'string' && args.hint ? args.hint : undefined;
      const counterpart = typeof args.counterpart === 'string' && args.counterpart ? args.counterpart : undefined;

      // 触发自我继续（异步，当前回合结束后自动开始下一轮）
      self.continueTurn(counterpart, hint);

      return JSON.stringify({
        status: 'ok',
        data: {
          message: '已触发自我继续，当前回合结束后将自动开始下一轮推理。',
          hint: hint ?? undefined,
          counterpart: counterpart ?? 'current',
        },
      });
    } catch (err: any) {
      return JSON.stringify({ status: 'error', data: { message: `触发继续失败: ${err.message}` } });
    }
  },
};
