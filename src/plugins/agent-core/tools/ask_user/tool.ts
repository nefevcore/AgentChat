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
import { getInteractionBridge } from '@infra/interactions';

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
            description: '要问用户的问题（清晰、具体）。可与 questions 二选一：单题用 question+options，多题用 questions。',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '用户可选的选项列表（2-5 个，简短明确）',
          },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '问题' },
                options: { type: 'array', items: { type: 'string' }, description: '选项（2-5 个）' },
              },
              required: ['question', 'options'],
            },
            description: '批量选择题：一次提供多个问题，前端左右切换逐题回答（避免来回调用工具）',
          },
          allow_custom: {
            type: 'boolean',
            description: '是否允许用户输入自定义答案（默认 false，弹窗始终含"其他"输入）',
          },
          timeout_ms: {
            type: 'number',
            description: '等待超时（毫秒，默认 120000）',
          },
        },
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

    const agentId = args.from || 'unknown';
    const convKey = args.convKey || `${agentId}__unknown`;
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000;

    // 批量选择题：questions 数组优先
    const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
    if (rawQuestions.length > 0) {
      const qs = rawQuestions.slice(0, 5).map((q: any) => ({
        question: String(q?.question || ''),
        options: (Array.isArray(q?.options) ? q.options.map(String) : []).slice(0, 6),
      })).filter(q => q.question && q.options.length > 0);
      if (qs.length > 0) {
        try {
          const answers = await bridge.askQuestions({
            agentId, convKey, questions: qs, allowCustom: args.allow_custom === true,
            timeoutMs, signal,
          });
          return JSON.stringify({ status: 'ok', data: { answers, questions: qs } });
        } catch (err: any) {
          return JSON.stringify({ status: 'timeout', data: { message: err.message || '用户未响应', questions: qs } });
        }
      }
    }

    // 单题
    const question = String(args.question || '');
    const options: string[] = Array.isArray(args.options) ? args.options.map(String) : [];
    if (!question || options.length === 0) {
      return JSON.stringify({ status: 'error', data: { message: '需要 question+options 或 questions' } });
    }
    const limitedOptions = options.slice(0, 6);

    try {
      const choice = await bridge.askUser({
        agentId, convKey,
        question,
        options: limitedOptions,
        allowCustom: args.allow_custom === true,
        timeoutMs,
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
