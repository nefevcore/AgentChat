// ============================================================
// @agentchat/contracts/src/engine.ts —— 引擎域契约
//
// 迁移自 @agentchat/agent-loop/src/contracts.ts：
//   · Tool / RunResult / AgentResult / CoreEventType
// 消息/工具定义契约归 @agentchat/types，LLM 契约归 @agentchat/llm。
// 铁律：本文件不产生运行时依赖（全部为类型）。
// ============================================================

import type { InterruptReason } from './interrupt';
import type { AgentMessage, ToolDefinition, ToolStream } from '@agentchat/types';
import type { LLMUsage } from '@agentchat/llm';

// ============================================================
// 工具契约（可执行 Tool 由引擎定义，tools 域实现）
// ============================================================

/** 工具执行上下文（loop 在 runTools 中注入；可选第四参，保持旧工具兼容） */
export interface ToolExecutionContext {
  /** 本次工具调用的稳定 id（与 assistant.tool_calls[].id 一致，恢复对账用） */
  toolCallId: string;
  /** 会话键（dialogId / convKey） */
  dialogId?: string;
  /** 当前执行 Agent ID */
  agentId?: string;
}

/** 可执行的工具 */
export interface Tool {
  /** 工具名（= definition.function.name） */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
  /** 命名空间（如 "tool.bash"；仅声明且有真实配置读取点的工具设置，其余可省略） */
  ns?: string;
  /** 能力标签要求（受控词汇表 base/dev/admin/conductor；AND 语义：全部命中才可用；缺省 = 默认关闭，只能 include 显式启用） */
  requires?: string[];
  definition: ToolDefinition;
  /**
   * 执行工具。返回 string 仅给 LLM；返回 { content, details } 分离 LLM 内容与 UI 详情。
   * stream 可选，用于流式输出进度；signal 可选，用于外部中断（用户取消/优雅关闭）；
   * exec 可选，提供 toolCallId/dialogId/agentId（恢复对账与持久化用）。
   */
  execute: (args: Record<string, any>, stream?: ToolStream, signal?: AbortSignal, exec?: ToolExecutionContext) => Promise<string | { content: string; details?: any }>;
  /** 从参数中提取简短描述用于 UI 标签（可选，不填则只展示 label） */
  extractLabel?: (args: Record<string, any>) => string;
}

// ============================================================
// 执行结果（run 生命周期边界 chat.start/chat.end 共享契约）
// ============================================================

/** 单次 run() 执行结果（整次 ReAct 生命周期，可能多步） */
export interface RunResult {
  /** 最终回复内容 */
  content: string;
  /** 是否被中断 */
  interrupted: boolean;
  /** 语义化中断原因 */
  interruptReason?: InterruptReason;
  /** 整次执行产生的完整消息序列（assistant/tool/error/steer），供调用方持久化 */
  messages: AgentMessage[];
  /** 整次执行累计 Token 用量 */
  usage?: LLMUsage;
}

/** Agent 单次执行结果（装配层返回） */
export interface AgentResult {
  content: string;
  interrupted: boolean;
  /** 语义化中断原因（替代裸 boolean，区分用户打断/工具中止/reload/restart） */
  interruptReason?: InterruptReason;
}

// ============================================================
// 事件类型（loop emit 载荷）
// ============================================================

/** L1 引擎发射的流式事件类型（WebUI 等上层据此驱动实时界面） */
export type CoreEventType =
  | 'chat.start' | 'chat.end'
  | 'chat.step.start' | 'chat.step.end' | 'chat.step.steered'
  | 'chat.message.start' | 'chat.message.update' | 'chat.message.end' | 'chat.message.error'
  | 'chat.thinking.start' | 'chat.thinking.update' | 'chat.thinking.end'
  | 'chat.toolcall.start' | 'chat.toolcall.update' | 'chat.toolcall.end'
  | 'chat.tool_execution.start' | 'chat.tool_execution.update' | 'chat.tool_execution.end';
