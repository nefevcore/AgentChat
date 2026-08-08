// ============================================================
// src/agents/virtual-agent.ts —— 虚拟 Agent（user 端点，← core 移入）
//
// 虚拟 Agent（如 user）没有 LLM，不进行 ReAct 推理循环。
// 它是纯路由端点：receive() 仅确认收到，不虚构 assistant 回复。
//
// 已简化（相对旧实现）：
//   · 无 pre/post hook 管道（持久化/hook 由 L4/L5 监听 router 'message' 事件完成）
//   · 无执行队列（L2 router 已负责分发；虚拟端点极快，无并发风险）
//   · 无事件总线（chat.virtual.receive 由 L5 从 router 'message' 事件派生）
//
// 依赖方向：仅依赖 src/core 与本层 config/router 类型（相对导入）。
// ============================================================

import type { AgentResult } from '@core/types';
import type { AgentConfig } from './config';
import type { AgentMessage, TriggerOptions } from './router';

/** 虚拟 Agent —— 无 LLM 推理，仅作路由端点 */
export class VirtualAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  get agentId(): string {
    return this.config.agent_id;
  }

  get name(): string {
    return this.config.name;
  }

  /**
   * 接收消息：纯确认回执。
   * 发送方 Agent 通过工具返回值确认投递成功即可，不虚构 assistant 回复。
   */
  async receive(message: AgentMessage, _signal?: AbortSignal): Promise<AgentResult> {
    return {
      content: `[VirtualAgent] "${this.agentId}" 已收到来自 "${message.from}" 的消息`,
      interrupted: false,
    };
  }

  /** 自主推理入口：虚拟 Agent 不支持，直接返回 */
  async trigger(_options?: TriggerOptions, _signal?: AbortSignal): Promise<AgentResult> {
    return {
      content: `[VirtualAgent] "${this.agentId}" 是虚拟 Agent，不支持自主推理。`,
      interrupted: false,
    };
  }
}
