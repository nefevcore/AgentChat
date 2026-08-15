// ============================================================
// @agentchat/agent-loop/src/contracts.ts —— 引擎域契约
//
// 迁移自 AgentChat src/core/types.ts（抽取 RunResult/AgentResult/
// CoreEventType/Tool 部分）；消息契约 AgentMessage 归 @agentchat/types，
// LLM 契约归 @agentchat/llm。
//
// 铁律：本文件不产生运行时依赖（全部为类型），仅声明。
// ============================================================

import type { InterruptReason } from './interrupt';
// 本地声明需要的类型（不再 re-export：消息/工具定义归 @agentchat/types，LLM 契约归 @agentchat/llm）
import type { AgentMessage, ToolDefinition, ToolStream } from '@agentchat/types';
import type { LLMUsage } from '@agentchat/llm';

// ============================================================
// 工具契约（可执行 Tool 由引擎定义，tools 域实现）
// ============================================================

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
  /** 能力标签要求（AND 语义：Agent 需包含全部 requires 标签才可用；缺省 = 无限制） */
  requires?: string[];
  definition: ToolDefinition;
  /**
   * 执行工具。返回 string 仅给 LLM；返回 { content, details } 分离 LLM 内容与 UI 详情。
   * stream 可选，用于流式输出进度；signal 可选，用于外部中断（用户取消/优雅关闭）。
   */
  execute: (args: Record<string, any>, stream?: ToolStream, signal?: AbortSignal) => Promise<string | { content: string; details?: any }>;
  /** 从参数中提取简短描述用于 UI 标签（可选，不填则只展示 label） */
  extractLabel?: (args: Record<string, any>) => string;
}

// ============================================================
// 执行结果（run 生命周期边界 chat.start/chat.end 共享契约）
// ============================================================

/** 单次 run() 执行结果（整次 ReAct 生命周期，可能多轮） */
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
  | 'chat.turn.start' | 'chat.turn.end' | 'chat.turn.steered'
  | 'chat.message.start' | 'chat.message.update' | 'chat.message.end' | 'chat.message.error'
  | 'chat.thinking.start' | 'chat.thinking.update' | 'chat.thinking.end'
  | 'chat.toolcall.start' | 'chat.toolcall.update' | 'chat.toolcall.end'
  | 'chat.tool_execution.start' | 'chat.tool_execution.update' | 'chat.tool_execution.end';
