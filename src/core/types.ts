// ============================================================
// src/core/types.ts —— L1 引擎核心契约（依赖根：零外部依赖）
//
// 职责：L1 引擎（loop / context / llm）与上层之间的最小契约集合。
//   · 消息模型：Message / ToolCall / PersistedToolCall
//   · LLM 契约：LLMProvider / LLMRequest / LLMResponse / LLMUsage / StreamToken / LLMConfig
//   · 工具契约：Tool / ToolDefinition / ToolStream
//
// 铁律：本文件不 import 任何其他模块（含 Node 内置与 npm 包），
//       仅声明类型与常量，保证 L1 可被任意层引用而不形成环。
//       中断类型（InterruptReason）经 inline import 引用，不产生运行时依赖。
// ============================================================

// ============================================================
// 消息模型
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
 * 通用消息结构。
 * role='agent' 为持久化格式（归属由 agent_id 标记，provider 依据 viewer 做视角转换）。
 */
export interface Message {
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
 * LLM 请求消息 —— 与 Message 同构。
 * 由 provider 的 toProviderMessages 负责角色解析（trigger→user、error→tool、agent 视角转换）。
 */
export type LLMRequestMessage = Message;

// ============================================================
// LLM 契约
// ============================================================

/**
 * LLM 配置 —— 唯一来源的共通参数（snake_case，对应 config.json / 模型池条目）。
 *
 * 参考条目（测试用）：
 *   "deepseek-v4-flash": {
 *     "provider": "deepseek",
 *     "base_url": "https://api.deepseek.com",
 *     "model": "deepseek-v4-flash",
 *     "reasoning_effort": "high",
 *     "thinking": true,
 *     "logprobs": false,
 *     "tool_choice": "auto",
 *     "default": true
 *   }
 */
export interface LLMConfig {
  /** 池引用名称（指向模型池条目，如 "deepseek-v4-flash"） */
  $ref?: string;
  /** 提供商类型 */
  provider?: 'openai' | 'deepseek' | 'ollama';
  /** API Key，支持 ${ENV_VAR} 环境变量引用 */
  api_key?: string;
  /** API 地址（默认按 provider 推断） */
  base_url?: string;
  /** 模型名（默认按 provider 推断） */
  model?: string;
  /** 温度参数（0-2） */
  temperature?: number | null;
  /** 最大输出 token（0/null = 不限制） */
  max_tokens?: number | null;
  /** 核采样参数（0-1） */
  top_p?: number | null;
  /** 输出格式 */
  response_format?: 'text' | 'json_object' | null;
  /** 停止词（最多 16 个） */
  stop?: string | string[] | null;
  /** [DeepSeek] 思考强度 */
  reasoning_effort?: 'high' | 'max';
  /** [DeepSeek] 是否默认开启思考模式 */
  thinking?: boolean;
  /** [DeepSeek] 是否返回输出 token 的对数概率 */
  logprobs?: boolean | null;
  /** [DeepSeek] 返回 top N 概率 token 及其对数概率（0-20） */
  top_logprobs?: number | null;
  /** [DeepSeek] 工具选择策略 */
  tool_choice?: 'none' | 'auto' | 'required' | null;
}

/** LLM 调用请求 */
export interface LLMRequest {
  messages: LLMRequestMessage[];
  /**
   * 当前视角（viewer）Agent ID —— 持久化消息（role='agent'）的视角转换依据：
   * agent_id===viewer → assistant；agent_id≠viewer → user；agent_id==='user' 恒为 user。
   */
  viewer?: string;
  /** OpenAI 兼容工具定义（function-calling） */
  tools?: ToolDefinition[];
  /** 是否启用深度思考（DeepSeek thinking），默认 true */
  thinking?: boolean;
  /**
   * 业务侧用户标识，用于 DeepSeek API 的 user_id 隔离。
   * 值为 "<sender>__<receiver>"，确保每个对话对拥有独立的上下文缓存与限速命名空间。
   */
  userId?: string;
  /** 按请求覆写温度（null/undefined 使用实例默认） */
  temperature?: number | null;
  /** 按请求覆写最大输出 token */
  maxTokens?: number | null;
  /** 按请求覆写核采样参数 */
  topP?: number | null;
  /** 按请求覆写停止词 */
  stop?: string | string[] | null;
}

/** LLM 调用响应 —— 标准化输出 */
export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  /** 思维链/推理内容（DeepSeek R1 等模型的 reasoning_content） */
  reasoning?: string;
  /** 本次 LLM 调用的 Token 用量 */
  usage?: LLMUsage;
}

/**
 * LLM Token 用量统计（兼容 OpenAI / DeepSeek 格式）。
 * DeepSeek 额外字段：prompt_cache_hit_tokens / prompt_cache_miss_tokens。
 */
export interface LLMUsage {
  /** 本次（最近一次 API 调用）的提示词 token 数 */
  prompt_tokens: number;
  /** 累计补全（输出）token 数（跨 ReAct turn 累加） */
  completion_tokens: number;
  /** 本次（最近一次 API 调用）的总 token 数 */
  total_tokens: number;
  /** [DeepSeek] 缓存命中的输入 token 数（跨 turn 累加） */
  prompt_cache_hit_tokens?: number;
  /** [DeepSeek] 缓存未命中的输入 token 数（跨 turn 累加） */
  prompt_cache_miss_tokens?: number;
  /** 累计提示词 token 数（跨 turn 累加，用于展示总用量） */
  accumulated_prompt_tokens?: number;
  /** 累计总 token 数（跨 turn 累加） */
  accumulated_total_tokens?: number;
  /** ReAct 迭代次数 */
  react_turns?: number;
}

// ============================================================
// 单次执行结果（run 生命周期边界 chat.start/chat.end 共享契约）
// ============================================================

/** 单次 run() 执行结果（整次 ReAct 生命周期，可能多轮） */
export interface RunResult {
  /** 最终回复内容 */
  content: string;
  /** 是否被中断 */
  interrupted: boolean;
  /** 语义化中断原因（inline import：不产生运行时依赖） */
  interruptReason?: import('./interrupt').InterruptReason;
  /** 整次执行产生的完整消息序列（assistant/tool/error/steer），供调用方持久化 */
  messages: Message[];
  /** 整次执行累计 Token 用量 */
  usage?: LLMUsage;
}

/** LLM 提供者 —— Agent 与 LLM 适配器之间的抽象接口 */
export interface LLMProvider {
  /** 模型名（供 usage 记录按模型统计） */
  readonly model: string;
  /** 非流式调用 LLM，一次性返回完整响应 */
  chat(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
  /** 流式调用 LLM，返回 AsyncIterable<StreamToken> + .result() */
  stream(req: LLMRequest, signal?: AbortSignal): AsyncIterable<StreamToken> & { result(): Promise<LLMResponse> };
  /**
   * 正向转换：项目消息（持久化或内存格式）→ 本 provider 的 LLM API 原生消息。
   * 由各 provider 负责角色映射（含 role='agent' 视角转换）、工具调用归一化与消息合法性防御过滤。
   */
  toProviderMessages(messages: LLMRequestMessage[], viewer?: string): any[];
  /**
   * 反向转换：LLM API 原生消息（OpenAI 格式）→ 项目消息（简化 ToolCall）。
   * 与 toProviderMessages 对称。
   */
  fromProviderMessages(messages: any[]): LLMRequestMessage[];
}

/** 流式 token —— LLM 输出的原子单位，type 同时承载内容类型和生命周期阶段 */
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

// ============================================================
// 工具契约
// ============================================================

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
// 执行结果
// ============================================================

/** Agent 单次执行结果（装配层返回） */
export interface AgentResult {
  content: string;
  interrupted: boolean;
  /** 语义化中断原因（替代裸 boolean，区分用户打断/工具中止/reload/restart） */
  interruptReason?: import('./interrupt').InterruptReason;
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
