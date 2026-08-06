// ============================================================
// send_agent 工具 —— 向其他 Agent 发送消息（trigger 模式）
//
// 设计原则：
//   1. Trigger 模式（默认）：fire-and-forget，立即返回"稍后回复"
//   2. 对方 Agent 通过队列排队处理，连续消息自动批量合并
//   3. 对方处理完成后通过 send_agent 回复，形成会话循环
//   4. 会话连续性由 agent-session 框架保证
// ============================================================

import { Tool } from '@core/types';
import { meta } from './meta';
import { getAppState } from '@core/app-state';
import type { AgentRouter } from '@agents/router';
import type { AgentRegistry } from '@agents/registry';

// ---- 工具定义 ----

export const tool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'send_agent',
      description:
        '向另一个 Agent 发送消息，稍后回复（Agent 间通讯的唯一方式）。' +
        '每次调用独立无状态，多轮对话需自行传递上下文。' +
        '消息投递后对方会自行处理并回复，无需等待。',
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
            description: '是否仅投递不等待回复（默认 true）。设为 false 可同步等待对方回复。',
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

    const { to, message, no_wait = true } = args;
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
        return `[send_agent] 已成功发出消息到 "${to}"，稍后回复。${ack}`;
      } catch (err: any) {
        return `[send_agent] 向 "${to}" 投递失败：${err.message}`;
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
