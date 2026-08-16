// ============================================================
// src/agents/virtual-agent.ts —— 虚拟 Agent（user 端点，← core 移入）
//
// 虚拟 Agent（如 user）没有 LLM，不进行 ReAct 推理循环。
//
// 接收消息（receive）：**不再由 router 直接调用** —— 虚拟 Agent 与真实 Agent
// 一样走统一 run 流程（router.dispatch → createAgentContext → runWithGate），
// loop 对 ctx.virtual 跳过 LLM 推理，但完整走 hook 管道（runStart/stepStart/
// stepEnd/runEnd），消息由 runEnd saveSession 自然落盘。receive 保留仅为
// 接口兼容（无人调用）。
//
// 自主推理（trigger）：虚拟 Agent 无 LLM，不支持，直接返回。
//
// 依赖方向：仅依赖 src/core 与本层 config/router 类型（相对导入）。
// ============================================================

import type { AgentResult } from '@agentchat/agent-loop';
import type { AgentConfig } from '@agentchat/agent-config';
import type { RouterMessage, TriggerOptions } from './router';

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
   * ⚠️ 已弃用：虚拟 Agent 现走统一 run 流程（router.dispatch），本方法保留仅为接口兼容。
   * 发送方 Agent 通过工具返回值确认投递成功即可，不虚构 assistant 回复。
   */
  async receive(message: RouterMessage, _signal?: AbortSignal): Promise<AgentResult> {
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
