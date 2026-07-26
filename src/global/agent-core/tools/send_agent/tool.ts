// ============================================================
// send_agent 工具 —— 向其他 Agent 发送消息
//
// 设计原则：
//   1. 无状态设计：每次调用都是独立的 send → response 生命周期
//   2. 通过 getAppState().router 获取运行时 AgentRouter
//   3. 自动生成 correlation_id 用于追踪
//   4. 返回目标 Agent 的完整响应文本
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import type { AgentRouter } from '@routing/router';
import type { AgentRegistry } from '@routing/registry';

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_agent',
      description:
        '向另一个 Agent 发送消息并获取响应（Agent 间通讯的唯一方式）。' +
        '每次调用独立无状态，多轮对话需自行传递上下文。' +
        '设置 no_wait=true 可仅投递消息不等待回复，对方会自行响应。',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: '目标 Agent ID（通过 list_agents 获取）',
          },
          message: {
            type: 'string',
            description: '消息内容',
          },
          no_wait: {
            type: 'boolean',
            description: '是否仅投递不等待回复（默认 false）。设为 true 时立即返回投递确认，目标 Agent 会自行回复。适用于对话已建立的场景。',
          },
        },
        required: ['to', 'message'],
      },
    },
  },
  ...meta,

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

    const { to, message, no_wait } = args;
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

    // ---- no_wait 模式：fire-and-forget，不等待回复 ----
    if (no_wait) {
      try {
        const ack = await r.sendAsync({
          from,
          to,
          type: 'request',
          payload: message,
          correlation_id: correlationId,
        });
        return `[send_agent] 已投递消息到 "${to}"（异步模式，不等待回复）。${ack}`;
      } catch (err: any) {
        return `[send_agent] 向 "${to}" 异步投递失败：${err.message}`;
      }
    }

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
