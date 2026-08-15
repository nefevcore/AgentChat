// ============================================================
// @agentchat/llm/src/contracts.ts —— LLM 域契约（自包含，零依赖）
//
// 迁移自 AgentChat src/core/types.ts（抽取 LLM + 消息 + 工具定义部分）。
// 铁律：本文件不 import 任何模块，仅声明类型与常量。
//
// 抽取范围（对照原 core/types.ts 节）：
//   · 消息模型/工具定义  —— 已下沉 @agentchat/types，本文件 re-export 保持兼容
//   · LLM 契约           —— LLMConfig / LLMRequest / LLMResponse / LLMUsage / LLMProvider / StreamToken
// 未抽取（归其他域）：RunResult / AgentResult / CoreEventType → agent-loop；Tool → tools。
// ============================================================

import type {
  LLMRequestMessage,
  ToolCall,
  ToolDefinition,
  ToolStream,
} from '@agentchat/types';

// ============================================================
// LLM 契约
// ============================================================

/**
 * LLM 配置 —— 唯一来源的共通参数（snake_case，对应 config.json / 模型池条目）。
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

