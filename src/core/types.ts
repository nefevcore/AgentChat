// ============================================================
// AgentChat 核心类型定义
// ============================================================

import type { LLMConfig } from '../discovery/config-types';

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
 * 运行时配置片段（来自 AppConfig 的子集）
 * 用于 AgentContext 中传递 per-agent 覆盖
 */
export interface RuntimeConfig {
  maxContextTokens?: number;
  keepRecentMessages?: number;
  summaryPreviewLen?: number;
  maxMemoryFacts?: number;
  bashDefaultTimeout?: number;
  bashMaxTimeout?: number;
  bashOutputMaxLen?: number;
  readOutputMaxLen?: number;
  webSearchDefaultResults?: number;
  webSearchDefaultDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  webSearchDefaultTopic?: 'general' | 'news' | 'finance';
  messageQueryDefaultLimit?: number;
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
   * 本轮 ReAct 循环产生的完整消息（含工具调用、工具结果、思维链）
   * 由 Agent.run() 在执行完成后填充，供 PostProcessHook 持久化
   */
  loopMessages?: Message[];
  /**
   * 运行时配置覆盖（可选）
   * 来自 Agent 的 config.json 中 runtime 字段，用于 per-agent 调参
   * 扩展（如 agent-session）可合并此配置覆盖全局默认值
   */
  runtimeConfig?: RuntimeConfig;
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
  execute: (args: Record<string, any>) => Promise<string>;
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
  | 'chat.send' | 'chat.interrupt' | 'chat.interrupted'
  | 'chat.response.start' | 'chat.response.chunk'
  | 'chat.response.done' | 'chat.thinking.start' | 'chat.thinking.chunk'
  | 'chat.thinking.done' | 'chat.tool.start' | 'chat.tool.done'
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
  /** 调用 LLM。传入 onChunk 走流式 SSE，不传走普通 JSON。 */
  chat(
    req: LLMRequest,
    signal?: AbortSignal,
    onChunk?: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): Promise<LLMResponse>;
}
