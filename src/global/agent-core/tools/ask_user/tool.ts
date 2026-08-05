// ============================================================
// ask_user 工具 —— 向用户提问等待决策（决策工具 #4）
//
// 场景：Agent 需要用户拍板时（二选一/确认/方向选择），
// 调用本工具 → WS 推前端弹窗 → 用户选择 → 结果返回给 Agent。
//
// 实现：
//   execute → getInteractionBridge().askUser() → Promise 挂起
//   → WS 推 chat.interaction → 前端弹窗 → 用户选择
//   → WS CHAT_INTERACT_RESPOND → bridge.respond() resolve → 返回选择
//   超时（默认 120s）→ reject → 工具返回超时信息
// ============================================================

import { Tool, ToolStream } from '@core/types';
import { meta } from './meta';
import { getInteractionBridge } from '@core/interactions';

export const tool: Tool = {
  ...meta,

  definition: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '向用户提出一个问题并提供选项，等待用户选择后继续（异步交互）。' +
        '适用于需要用户决策/确认的场景：二选一、确认执行某操作、选择方向等。' +
        '用户默认 120 秒内响应，超时返回"用户未响应"。' +
        '调用后会暂停当前推理直到用户选择，请确保问题清晰、选项明确。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '要问用户的问题（清晰、具体）',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '用户可选的选项列表（2-5 个，简短明确）',
          },
          allow_custom: {
            type: 'boolean',
            description: '是否允许用户输入自定义答案（默认 false）',
          },
          timeout_ms: {
            type: 'number',
            description: '等待超时（毫秒，默认 120000）',
          },
        },
        required: ['question', 'options'],
      },
    },
  },

  extractLabel: (args: Record<string, any>) => {
    return `❓ ${String(args.question || '').slice(0, 30)}`;
  },

  execute: async (args: Record<string, any>, stream?: ToolStream, signal?: AbortSignal): Promise<string> => {
    const bridge = getInteractionBridge();
    if (!bridge) {
      return JSON.stringify({ status: 'error', data: { message: '交互桥未初始化' } });
    }

    const question = String(args.question || '');
    const options: string[] = Array.isArray(args.options) ? args.options.map(String) : [];
    if (!question || options.length === 0) {
      return JSON.stringify({ status: 'error', data: { message: '需要 question 和至少 1 个 options' } });
    }
    // 限制选项数量
    const limitedOptions = options.slice(0, 6);

    try {
      const choice = await bridge.askUser({
        agentId: args.from || 'unknown',
        convKey: args.convKey || `${args.from || 'unknown'}__unknown`,
        question,
        options: limitedOptions,
        allowCustom: args.allow_custom === true,
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000,
        signal,
      });
      return JSON.stringify({
        status: 'ok',
        data: { choice, question, options: limitedOptions },
      });
    } catch (err: any) {
      // 超时或中断
      return JSON.stringify({
        status: 'timeout',
        data: { message: err.message || '用户未响应', question, options: limitedOptions },
      });
    }
  },
};
