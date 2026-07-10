// ============================================================
// send_agent 工具 —— 向其他 Agent 发送消息
//
// 设计原则：
//   1. 无状态设计：每次调用都是独立的 send → response 生命周期
//   2. 通过 getAppState().router 获取运行时 AgentRouter
//   3. 自动生成 correlation_id 用于追踪
//   4. 返回目标 Agent 的完整响应文本
// ============================================================

import { Tool } from '../../../core/types';
import { getAppState } from '../../../core/app-state';
import type { AgentRouter } from '../../../routing/router';
import type { AgentRegistry } from '../../../routing/registry';

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_agent',
      description:
        '向另一个 Agent 发送消息并获取其响应。这是 Agent 间通讯的唯一方式。' +
        '无状态设计：每次调用独立，不会自动传递上下文。' +
        '如需多轮对话，请在前一条响应的基础上自行构造后续消息。',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: '目标 Agent 的 ID（可通过 list_agents 获取可用清单）',
          },
          message: {
            type: 'string',
            description: '要发送给目标 Agent 的消息内容',
          },
        },
        required: ['to', 'message'],
      },
    },
  },
  displayName: '发送消息',
  description: '向另一个 Agent 发送消息并获取响应（无状态）',

  extractLabel: (args: Record<string, any>) => {
    return `→ ${args.to || '?'}`;
  },

  execute: async (args: Record<string, any>) => {
    const state = getAppState();
    const router = state.router;
    if (!router) {
      return `[send_agent] 错误：AgentRouter 未注册到 AppState。可用键：${Object.keys(state).join(', ') || '(无)'}`;
    }
    const r = router as AgentRouter;

    const { to, message } = args;
    // from 由 interceptor 注入，需校验发送方是否已注册
    const from = args.from as string;
    const registry = state.registry as AgentRegistry;
    if (registry && !registry.has(from)) {
      return `[send_agent] 错误：发送方 "${from}" 未在注册表中，无法发送消息。`;
    }
    if (registry && !registry.has(to)) {
      return `[send_agent] 错误：目标 "${to}" 未在注册表中。可用：${registry.listIds().join(', ')}`;
    }

    const correlationId = `send_agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const response = await r.send({
        from,
        to,
        type: 'request',
        payload: message,
        correlation_id: correlationId,
      });
      return response;
    } catch (err: any) {
      return `[send_agent] 向 "${to}" 发送消息失败：${err.message}`;
    }
  },
};
