// ============================================================
// @agentchat/types —— AgentChat 核心域契约（零运行时依赖）
//
// 统一消息/工具定义/流式回调等跨包共享契约。
// 铁律：本文件不 import 任何模块，仅声明类型。
//
// 归属说明：
//   · AgentMessage / LLMRequestMessage —— 统一消息模型
//   · ToolCall / PersistedToolCall / ToolDefinition / ToolStream —— 工具相关契约
//   · 跨端/持久化 DTO 归 @agentchat/protocol
//   · LLM Provider 契约归 @agentchat/llm
// ============================================================

/** 消息角色（含持久化格式 role='agent' 与内存格式 trigger/error） */
export type MessageRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'trigger'
  | 'agent';

/** 简化工具调用（内存格式，arguments 为对象） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** OpenAI 原生工具调用（持久化/API 格式，arguments 为 JSON 字符串） */
export interface PersistedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * 统一的领域消息格式（唯一消息契约）。
 * role='agent' 为持久化格式（归属由 agent_id 标记，provider 依据 viewer 做视角转换）。
 */
export interface AgentMessage {
  role: MessageRole;
  content: string;
  /** 消息唯一标识（持久化用） */
  message_id?: string;
  /** 消息归属 Agent ID（持久化格式 role='agent' 时必填） */
  agent_id?: string;
  /** 工具名称（tool 角色消息） */
  name?: string;
  /** 工具调用 ID（tool 角色消息，与 assistant.tool_calls 配对） */
  tool_call_id?: string;
  /** 工具调用（assistant 消息），兼容简化与 OpenAI 原生两种格式 */
  tool_calls?: ToolCall[] | PersistedToolCall[];
  /** 思维链/推理内容（DeepSeek reasoning_content） */
  reasoning_content?: string;
  /** UI 展示标签 */
  label?: string;
  /** 时间戳（持久化用） */
  timestamp?: string;
}

/**
 * LLM 请求消息 —— 与 AgentMessage 同构。
 * 由 provider 的 toProviderMessages 负责角色解析（trigger→user、error→tool、agent 视角转换）。
 */
export type LLMRequestMessage = AgentMessage;

/** OpenAI 兼容的工具定义 (function-calling) */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** 工具执行时的流式回调，loop 通过它发射 chat.tool_execution.update 事件 */
export interface ToolStream {
  onChunk: (delta: string) => void;
}
