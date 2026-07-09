// ============================================================
// AgentChat 核心类型定义
// ============================================================

import type { LLMConfig, AgentConfig } from '../discovery/config-types';

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** LLM 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** 通用消息结构 */
export interface Message {
  role: MessageRole;
  content: string;
  /** 消息来源 Agent ID，用于多 Agent 会话中辨识消息归属 */
  agent_id?: string;
  /** 参与者名称（部分 API 要求在 tool 角色消息中必须提供函数名） */
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** 思维链/推理内容 (DeepSeek R1 等模型) */
  reasoning_content?: string;
  /** 展示标签（如 "[read] 读取 /path/to/file"、"已思考（用时 3 秒）"） */
  label?: string;
}

/**
 * Agent 上下文 —— 纯数据对象，不包含状态管理
 * Extension 通过 ctx.sender 实现多 Agent 隔离
 */
export interface AgentContext {
  /** 消息发起方 Agent ID */
  sender: string;
  /** 消息接收方 Agent ID（通常 = Agent.agentId） */
  receiver: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 对话历史 */
  history: Message[];
  /** 当前用户消息（可选，ReAct 循环中的当前轮次） */
  currentMessage?: Message;
  /**
   * 完整 Agent 配置（含扩展/工具命名空间配置）。
   * 由 Agent.receive() 自动注入，供扩展（如 agent-session）读取。
   */
  agentConfig?: AgentConfig;
  /**
   * Agent 级运行时配置覆盖（命名空间字典）。
   *
   * 由 Agent.run() 从 agentConfig 中提取命名空间键（如 "extension.agent_session"、
   * "tool.bash"）填充。工具/扩展通过各自的 resolveXxxConfig() 合并此覆盖。
   */
  runtimeConfig?: Record<string, Record<string, unknown>>;
  /**
   * 本轮 ReAct 循环产生的完整消息（含工具调用、工具结果、思维链）
   * 由 Agent.run() 在执行完成后填充，供 PostProcessHook 持久化
   */
  loopMessages?: Message[];
  /**
   * Agent 的 LLM 实例（可选）
   * 由 Agent.run() 自动注入，供扩展（如 agent-session 的摘要生成）使用
   */
  llm?: LLMProvider;
  /**
   * Agent 的 LLM 配置（可选）
   * 由 Agent.run() 自动注入，供扩展读取 LLM 参数（temperature、reasoning_effort 等）
   */
  llmConfig?: LLMConfig;
  /**
   * 本轮 Agent.run() 累计 Token 用量。
   * 由 Agent 在 ReAct 循环中逐次累加，供扩展（如 agent-session）记录和分析。
   * 仅在 run() 执行完成后可用（即 postHook 中可读取）。
   */
  cumulativeUsage?: LLMUsage;
  /**
   * 本轮可用工具概览（由 Agent.run() 在 applyPreHooks 前注入）。
   * 供扩展（如 agent-prompt）生成工具列表和动态 guidelines。
   */
  availableTools?: Array<{ name: string; displayName?: string; description: string }>;
  /**
   * 扩展间共享元数据。PreHook 可写入任意键值对，
   * 下游 PreHook 可读取。例如 agent-skill 写入 skillCount，
   * agent-prompt 据此调整 guidelines。
   */
  meta?: Record<string, unknown>;
}

/**
 * 扩展钩子类型
 * PreProcessHook:  进入 ReAct 循环前调用，可修改上下文（压缩、注入记忆）
 * PostProcessHook:  ReAct 循环结束后调用，用于持久化、日志等
 */
export type PreProcessHook = (ctx: AgentContext) => Promise<AgentContext>;
export type PostProcessHook = (ctx: AgentContext, response: string) => Promise<void>;

/** OpenAI 兼容的工具定义 (function-calling) */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** 可执行的工具 */
export interface Tool {
  definition: ToolDefinition;
  /** 执行工具。返回 string 仅给 LLM；返回 { content, details } 分离 LLM 内容和 UI 详情 */
  execute: (args: Record<string, any>) => Promise<string | { content: string; details?: any }>;
  /** UI 展示用中文名（可选），不填则回退到 definition.function.name */
  displayName?: string;
  /** 工具功能描述，用于前端插件列表中展示（可选），不填则回退到 definition.function.description */
  description?: string;
  /** 从参数中提取简短描述用于 UI 标签（可选），不填则只展示 displayName */
  extractLabel?: (args: Record<string, any>) => string;
}

/** 扩展钩子插件元数据 */
export interface HookPluginMeta {
  /** 钩子名称（文件名，不含扩展名） */
  name: string;
  /** 功能描述，用于前端插件列表中展示 */
  description: string;
}

/**
 * Extension —— 扩展插件统一入口
 *
 * 每个扩展目录下必须有 extension.ts，默认导出该类型对象。
 * preHook / postHook 均为可选：简单扩展可只提供其中一个。
 */
export interface Extension {
  meta: HookPluginMeta;
  preHook?: PreProcessHook;
  postHook?: PostProcessHook;
}

// ============================================================
// 路由协议 (电话模式)
// ============================================================

/**
 * 内部消息类型：涵盖路由协议 + 流式输出 + 工具调用
 * 新增类型用于驱动 WebUI 的前端推送
 */
export type AgentMessageType =
  // 路由协议
  | 'request' | 'response' | 'broadcast'
  // 聊天流式输出
  | 'chat.send' | 'chat.interrupt'
  | 'chat.start' | 'chat.end'
  | 'chat.turn.start' | 'chat.turn.end'
  | 'chat.message.start' | 'chat.message.update' | 'chat.message.end'
  | 'chat.thinking.start' | 'chat.thinking.update' | 'chat.thinking.end'
  | 'chat.toolcall.start' | 'chat.toolcall.update' | 'chat.toolcall.end'
  | 'chat.tool_execution.start' | 'chat.tool_execution.end'
  // 系统类
  | 'agent.list' | 'agent.list.response'
  | 'history.request' | 'history.response'
  // 文件类
  | 'file.upload' | 'file.upload.progress' | 'file.upload.complete';

/** Agent 间通讯消息 */
export interface AgentMessage {
  /** 发送者 Agent ID */
  from: string;
  /** 接收者 Agent ID (broadcast 时可为 '*') */
  to: string;
  /** 消息类型 */
  type: AgentMessageType;
  /** 负载 */
  payload: string;
  /** 关联 ID，用于追踪上下文、防止死循环 */
  correlation_id?: string;
  /** 附加数据（结构化数据，用于流式等场景） */
  data?: Record<string, any>;
}

/** LLM 调用请求 */
export interface LLMRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  /** 是否启用深度思考模式 (DeepSeek thinking)，默认 true */
  thinking?: boolean;
  /**
   * 业务侧用户标识，用于 DeepSeek API 的 user_id 隔离。
   * 传入 agent_id 以实现同一账号下不同 Agent 的细粒度限速与调度隔离。
   * 参见: https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit
   */
  userId?: string;
}

/** LLM 调用响应 —— 标准化输出 */
export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  /** 思维链/推理内容 (DeepSeek R1 等模型的 reasoning_content) */
  reasoning?: string;
  /** 本次 LLM 调用的 Token 用量（由 LLM API 返回的 usage 对象） */
  usage?: LLMUsage;
}

/**
 * LLM Token 用量统计。
 * 兼容 OpenAI / DeepSeek 格式。
 *
 * DeepSeek 额外字段：
 *   - prompt_cache_hit_tokens:  命中上下文缓存的输入 token 数（计费折扣）
 *   - prompt_cache_miss_tokens: 未命中缓存的输入 token 数
 *
 * 参见：https://api-docs.deepseek.com/zh-cn/quick_start/token_usage
 */
export interface LLMUsage {
  /** 提示词（输入） token 数 */
  prompt_tokens: number;
  /** 补全（输出） token 数 */
  completion_tokens: number;
  /** 总 token 数 */
  total_tokens: number;
  /** [DeepSeek] 缓存命中的输入 token 数 */
  prompt_cache_hit_tokens?: number;
  /** [DeepSeek] 缓存未命中的输入 token 数 */
  prompt_cache_miss_tokens?: number;
}

/** LLM 提供者 —— Agent 与 LLM 适配器之间的抽象接口 */
export interface LLMProvider {
  /** 非流式调用 LLM，一次性返回完整响应 */
  chat(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
  /** 流式调用 LLM，返回 AsyncIterable<StreamToken> + .result() */
  stream(req: LLMRequest, signal?: AbortSignal): AsyncIterable<StreamToken> & { result(): Promise<LLMResponse> };
}

/** 流式 token — LLM 输出的原子单位，type 同时承载内容类型和生命周期阶段 */
export interface StreamToken {
  type: 'thinking_start' | 'thinking_update' | 'thinking_end'
      | 'message_start' | 'message_update' | 'message_end'
      | 'toolcall_start' | 'toolcall_update' | 'toolcall_end'
      | 'error';
  delta?: string;
  /** 到当前为止的累计状态 */
  partial: { content: string; reasoning: string };
  /** 工具调用增量信息（仅 toolcall_* 时有效） */
  toolCall?: { index: number; id?: string; name?: string; arguments?: string };
  /** 错误描述（仅 type='error' 时有效） */
  error?: string;
  /** Token 用量 */
  usage?: LLMUsage;
}
