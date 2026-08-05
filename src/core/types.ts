// ============================================================
// AgentChat 核心类型定义
// ============================================================

import type { LLMConfig, AgentConfig, Meta, ConfigField } from '@discovery/config-types';

/** 消息角色（内存层，2026-08-02 起含 trigger 一等角色） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'error' | 'trigger';

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
  /** 消息唯一标识（持久化用），来自 PersistedMessage.message_id */
  message_id?: string;
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
  /** 原始时间戳（ISO 字符串），归档时保留而非重写，避免历史时间失真 */
  timestamp?: string;
}

/** LLM API 工具调用（OpenAI 原生格式，持久化消息携带此格式） */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * LLM 请求消息 —— 统一接受「持久化消息格式」与「内存消息格式」。
 *
 * 持久化格式（来自 messages.jsonl / ctx.history，role ∈ system/agent/tool/trigger/error）：
 *   · role='agent' + agent_id 标记消息归属；provider 依据 LLMRequest.viewer
 *     （当前视角 Agent ID）做视角转换：agent + agent_id===viewer → assistant；
 *     agent + 其他 → user；agent_id==='user' → user
 *   · tool_calls 为 LLMToolCall（OpenAI 原生格式，arguments 为 JSON 字符串）
 *
 * 内存格式（ReAct 循环实时生成，role ∈ system/user/assistant/tool/error/trigger）：
 *   · 角色已解析，provider 直接映射
 *   · tool_calls 为简化 ToolCall[]（arguments 为对象）
 */
export interface LLMRequestMessage {
  role: MessageRole | 'agent';
  content: string | null;
  message_id?: string;
  /** 消息来源 Agent ID，用于多 Agent 会话中辨识消息归属（视角转换依据） */
  agent_id?: string;
  name?: string;
  tool_calls?: ToolCall[] | LLMToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp?: string;
}


export interface AgentResult {
  content: string;
  interrupted: boolean;
  /** 语义化中断原因（替代裸 boolean，区分用户打断/工具中止/reload/restart） */
  interruptReason?: import('./interrupt').InterruptReason;
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
  /** 对话历史（持久化格式，role=agent/tool/trigger/error/system，视角由 provider 解析） */
  history: LLMRequestMessage[];
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
  /** PreHook 可用此回调动态注册工具（MCP 等运行时发现工具） */
  registerTool?: (tool: Tool) => void;
  /**
   * 群组 ID（仅群组消息）。由 Agent.receive() 从 AgentMessage.group_id 传入。
   * Session 扩展据此决定加载房间历史而非 1:1 对话历史。
   */
  group_id?: string;
  /**
   * trigger() 推理结果的目标 Agent ID（可选）。
   *
   * 仅 trigger() 调用时设置。Agent 可在 system prompt 或 postHook 中据此将
   * 推理结果自动路由到目标（例如通过 send_agent 推送）。receive() 路径不设置此字段，
   * 隐式以 ctx.sender 为回复目标。
   */
  target?: string;
  /** VirtualAgent / 内部会话标记：postHook 检测到此标记后跳过持久化 */
  skipPersist?: boolean;
  /**
   * 归档整理轮标记（v0.4.x 归档重构）：
   * postHook 检测到上下文超阈值后触发此整理轮。整理轮 preHook 正常加载完整历史，
   * ReAct 整理 memory/TODO/note，但 postHook 不落盘——只写 .archive_done_<id> 标记。
   * 所有参与方（单边=agent，双边=agent+counterpart）整理完成后才归档。
   */
  archiveReview?: boolean;
  /**
   * VirtualAgent 专用标记：postHook 仅持久化收到的消息（currentMessage），
   * 跳过自己的回复与归档/压缩/用量等副作用。
   * 解决 VirtualAgent 消息丢失：进来（发给虚拟 Agent）的消息必须落盘，
   * 确认回复（"已收到"）是操作回执，不应写入历史。
   */
  persistIncomingOnly?: boolean;
  /**
   * 自我续推标记（continue_turn / continueTurn）：
   * hint 仅作本轮内存引导，postHook 持久化时跳过 currentMessage
   * （不落盘为"对方发来的 trigger"，避免续推显示方向错乱）。
   */
  selfContinue?: boolean;
}

/**
 * 扩展钩子类型
 * PreProcessHook:  进入 ReAct 循环前调用，可修改上下文（压缩、注入记忆）
 * PostProcessHook:  ReAct 循环结束后调用，用于持久化、日志等
 * ToolExecutionHook: 工具执行前调用，可审核/改写参数/注入上下文
 */
export type PreProcessHook = (ctx: AgentContext) => Promise<AgentContext>;
export type PostProcessHook = (ctx: AgentContext, response: string) => Promise<void>;

/**
 * ToolInterceptor —— 工具执行前拦截器（强制约束层）
 *
 * 不同于可选的 PreHook/PostHook，Interceptor 是框架级强制约束：
 * 每个工具调用都会经过所有注册的拦截器，任一拦截器返回 allow=false
 * 则工具不会执行，reason 作为错误返回给 LLM。
 *
 * 适用场景：身份注入（send_agent）、命令审核（bash）、参数校验等。
 */
export interface ToolInterceptContext {
  /** 调用该工具的 Agent ID */
  agentId: string;
  /** 当前会话对方（Agent 正在与之对话的 sender），供需要自我上下文/目标推理的工具使用 */
  sender?: string;
  /** 工具参数（可被拦截器改写） */
  args: Record<string, any>;
}

export interface ToolInterceptResult {
  /** false = 拒绝执行，reason 返回给 LLM */
  allow: boolean;
  /** 拦截原因（allow=false 时必填） */
  reason?: string;
  /** 可修改的参数（allow=true 时生效） */
  args: Record<string, any>;
}

export type ToolInterceptor = (
  toolName: string,
  ctx: ToolInterceptContext
) => ToolInterceptResult | Promise<ToolInterceptResult>;

/** OpenAI 兼容的工具定义 (function-calling) */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** 工具执行时的流式回调，Agent 通过它发射 chat.tool_execution.update 事件 */
export interface ToolStream {
  onChunk: (delta: string) => void;
}

/** 可执行的工具 */
export interface Tool extends Meta {
  /** 命名空间（如 "tool.bash"） */
  ns: string;
  /** 配置 Schema（可选） */
  configuration?: ConfigField[];
  definition: ToolDefinition;
  /** 执行工具。返回 string 仅给 LLM；返回 { content, details } 分离 LLM 内容和 UI 详情。stream 可选，用于流式输出进度；signal 可选，用于外部中断（用户取消/优雅关闭） */
  execute: (args: Record<string, any>, stream?: ToolStream, signal?: AbortSignal) => Promise<string | { content: string; details?: any }>;
  /** 工具拦截器（可选） */
  interceptor?: ToolInterceptor;
  /** 从参数中提取简短描述用于 UI 标签（可选），不填则只展示 label */
  extractLabel?: (args: Record<string, any>) => string;
}

/**
 * Extension —— 扩展插件统一入口
 *
 * 每个扩展目录下必须有 extension.ts，默认导出该类型对象。
 * preHook / postHook 均为可选：简单扩展可只提供其中一个。
 */
export interface Extension extends Meta {
  /** 命名空间（如 "extension.agent_prompt"） */
  ns: string;
  /** 配置 Schema（可选） */
  configuration?: ConfigField[];
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
  | 'chat.turn.start' | 'chat.turn.end' | 'chat.turn.steered' | 'chat.turn.steered'
  | 'chat.message.start' | 'chat.message.update' | 'chat.message.end' | 'chat.message.error'
  | 'chat.thinking.start' | 'chat.thinking.update' | 'chat.thinking.end'
  | 'chat.toolcall.start' | 'chat.toolcall.update' | 'chat.toolcall.end'
  | 'chat.tool_execution.start' | 'chat.tool_execution.update' | 'chat.tool_execution.end'
  // 系统类
  | 'agent.list' | 'agent.list.response'
  | 'history.request' | 'history.response'
  // 文件类
  | 'file.upload' | 'file.upload.progress' | 'file.upload.complete'
  // 房间类
  | 'group.create' | 'group.message' | 'group.join' | 'group.leave'
  | 'group.list' | 'group.list.response'
  | 'group.history.request' | 'group.history.response'
  // 虚拟 Agent 消息实时推送
  | 'chat.virtual.receive';

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
  /** 群组 ID（仅群组消息） */
  group_id?: string;
}

/** LLM 调用请求 */
export interface LLMRequest {
  messages: LLMRequestMessage[];
  /**
   * 当前视角（viewer）Agent ID —— 消息归属判定依据。
   * 传入持久化格式消息（role='agent'）时，provider 据此把 agent 消息转换为
   * assistant（agent_id===viewer，即当前视角自己发的）/ user（agent_id≠viewer，
   * 对方或外部发的；agent_id==='user' 恒为 user）。
   * 1:1 会话中为当前 Agent（self）；群聊中为正在查看共享历史的 Agent。
   */
  viewer?: string;
  tools?: ToolDefinition[];
  /** 是否启用深度思考模式 (DeepSeek thinking)，默认 true */
  thinking?: boolean;
  /**
   * 业务侧用户标识，用于 DeepSeek API 的 user_id 隔离。
   * 值为 "<sender>__<receiver>"（如 "agent_B__agent_A"），
   * 确保每个对话对拥有独立的上下文缓存与限速命名空间，
   * 避免多 Agent 互相交流时缓存互相污染。
   * 使用 __ 分隔：满足 API 正则 [a-zA-Z0-9\-_]+ 且 agent ID 极少含连续双下划线。
   * 参见: https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit
   */
  userId?: string;
  /**
   * 按请求覆写温度参数 (0-2)。
   * 仅在非 null/undefined 时生效，否则使用 LLM 实例默认值。
   */
  temperature?: number | null;
  /**
   * 按请求覆写最大输出 token。
   * 仅在非 null/undefined 且 >0 时生效，否则使用 LLM 实例默认值。
   */
  maxTokens?: number | null;
  /**
   * 按请求覆写核采样参数 (0-1)。
   * 仅在非 null/undefined 时生效，否则使用 LLM 实例默认值。
   */
  topP?: number | null;
  /**
   * 按请求覆写停止词。
   * 仅在非 null/undefined 时生效，否则使用 LLM 实例默认值。
   */
  stop?: string | string[] | null;
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
  /** 本次（最近一次 API 调用）的提示词 token 数 */
  prompt_tokens: number;
  /** 累计补全（输出） token 数（跨 ReAct turn 累加） */
  completion_tokens: number;
  /** 本次（最近一次 API 调用）的总 token 数 */
  total_tokens: number;
  /** [DeepSeek] 缓存命中的输入 token 数（跨 turn 累加） */
  prompt_cache_hit_tokens?: number;
  /** [DeepSeek] 缓存未命中的输入 token 数（跨 turn 累加） */
  prompt_cache_miss_tokens?: number;
  /** 累计提示词 token 数（跨 ReAct turn 累加，用于展示总用量） */
  accumulated_prompt_tokens?: number;
  /** 累计总 token 数（跨 ReAct turn 累加） */
  accumulated_total_tokens?: number;
  /** ReAct 迭代次数 */
  react_turns?: number;
}

/**
 * Agent 自主推理触发选项（无 currentMessage 的 ReAct 循环）。
 *
 * 与 receive() 不同，trigger() 不携带用户消息，Agent 仅基于 system prompt
 * + history 进行推理。适用于定时任务、文件监听、Agent 自省等场景。
 */
export interface TriggerOptions {
  /** 最大 ReAct 轮次，默认不限制（仅在调用方显式指定时生效） */
  maxTurns?: number;
  /** 是否启用深度思考 */
  deepThink?: boolean;
  /** 触发来源标识（纯日志/审计用，不影响会话路径）。例如 "hourly-cron"、"file-watcher" */
  source?: string;
  /** 可选的上下文提示，默认以 `<trigger>hint</trigger>` 格式注入为 user 角色消息 */
  hint?: string;
  /**
   * 是否用 `<trigger>` 标签包裹 hint（默认 true）。
   * receive 路径设为 false，让 Agent 间消息表现为普通 user 消息而非系统触发。
   */
  wrapHint?: boolean;
  /**
   * 推理结果目标 Agent ID。
   *
   * 与 receive() 中隐式的"回复给 sender"不同，trigger() 的 source 通常为 system，
   * 真正需要结果的可能是另一个 Agent 或 user。设置 target 后，Agent 可在推理中
   * 通过 ctx.target 获知结果应发送给谁（例如自动调用 send_agent 推送）。
   */
  target?: string;
  /**
   * 群组 ID（仅房间 trigger）。Session 扩展据此加载房间共享历史
   * 而非 1:1 对话历史，且 postHook 跳过持久化（由 GroupManager 负责）。
   */
  group_id?: string;
  /**
   * 归档整理轮标记：postHook 检测到上下文超阈值后，以 archiveReview=true
   * 触发整理轮。整理轮 preHook 正常加载完整历史，postHook 不落盘，
   * 只写 .archive_done_<id> 标记并检查是否所有参与方完成 → 归档。
   */
  archiveReview?: boolean;
  /**
   * 自我续推标记（continue_turn / continueTurn）：
   * hint 仅作本轮内存引导，持久化时跳过 currentMessage（不落盘为对方 trigger）。
   */
  selfContinue?: boolean;
}

/** 定时任务条目 */
export interface TimerEntry {
  /** 唯一标识 */
  id: string;
  /** 是否启用 */
  enabled: boolean;
  /** 调度模式：time=定时, delay=延时, random=随机, workday=工作日, holiday=节假日 */
  mode: 'time' | 'delay' | 'random' | 'workday' | 'holiday';
  /** 定时触发时间（HH:mm，mode=time/workday/holiday），如 "08:00" */
  time?: string;
  /** 延时间隔（如 "30s"/"5m"/"1h"，仅 mode=delay） */
  delay?: string;
  /** 随机最小间隔（仅 mode=random），如 "30s" */
  delayMin?: string;
  /** 随机最大间隔（仅 mode=random），如 "5m" */
  delayMax?: string;
  /** 重复次数：0 = 永久，N = 执行 N 次 */
  repeatCount?: number;
  /** 触发提示（&lt;trigger&gt; 内容） */
  hint: string;
  /** 目标 Agent ID（结果发给谁），默认 'user' */
  target?: string;
  /** 来源标识（日志用） */
  source?: string;
  /** 最大 ReAct 轮次，默认 5 */
  maxTurns?: number;
}

/** Agent 的定时任务配置（存储在 config.json 的 timer 命名空间下） */
export interface TimerConfig {
  entries: TimerEntry[];
}

/** 全局定时任务条目（每个 = 时间点 + 提示 + 目标） */
export interface GlobalScheduleEntry {
  /** 时间点（HH:mm） */
  time: string;
  /** 发送给 Agent 的提示内容（如报时文本 / 任务提醒） */
  hint?: string;
  /** 目标 Agent ID 列表；空 = 所有真实 Agent */
  targets?: string[];
}

/** 全局定时任务配置（原 ChimeConfig 泛化，配置键为全局 timer） */
export interface GlobalTimerConfig {
  /** 是否启用（旧字段，保留兼容；新逻辑按 tasks 是否为空自动判断） */
  enabled?: boolean;
  /** 时间点（HH:mm），如 ["09:00", "12:00", "18:00"] —— 兼容旧格式 */
  times?: string[];
  /** 扩展：完整任务条目（支持自定义 hint + targets，优先于 times） */
  tasks?: GlobalScheduleEntry[];
  /** 默认提示模板：{time} 会被替换为 HH:mm */
  defaultHint?: string;
}

/** 全局定时任务配置（兼容旧名 ChimeConfig） */
export type ChimeConfig = GlobalTimerConfig;

/** LLM 提供者 —— Agent 与 LLM 适配器之间的抽象接口 */
export interface LLMProvider {
  /** 非流式调用 LLM，一次性返回完整响应 */
  chat(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
  /** 流式调用 LLM，返回 AsyncIterable<StreamToken> + .result() */
  stream(req: LLMRequest, signal?: AbortSignal): AsyncIterable<StreamToken> & { result(): Promise<LLMResponse> };
  /**
   * 正向转换：将项目消息（持久化或内存格式）转换为本 provider 的 LLM API 原生消息。
   * 由各 provider 负责角色映射（含 role='agent' 的视角转换，依据 viewer=当前视角 Agent ID）、
   * 工具调用归一化与消息合法性（防御过滤），Agent 层不再拼装 LLM 消息。
   * 返回格式因 provider 而异，故类型用 any[]。
   */
  toProviderMessages(messages: LLMRequestMessage[], viewer?: string): any[];
  /**
   * 反向转换：将 LLM API 原生消息（OpenAI 格式，tool_calls.arguments 为 JSON 字符串）
   * 转换回项目消息（简化 ToolCall，arguments 为对象）。与 toProviderMessages 对称，
   * 转换动作全部收拢在 provider 内。
   */
  fromProviderMessages(messages: any[]): LLMRequestMessage[];
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

// ============================================================
// Group（群组）类型
// ============================================================

/** 群组配置 */
export interface GroupConfig {
  /** 房间唯一标识 */
  group_id: string;
  /** 房间显示名称 */
  name: string;
  /** 参与者 Agent ID 列表 */
  participants: string[];
  /** 创建时间戳 */
  created_at: number;
  /** 房间描述（可选） */
  description?: string;
}

/** 群组消息（扩展 AgentMessage） */
export interface GroupMessage extends AgentMessage {
  /** 所属群组 ID */
  group_id: string;
}

/** 房间持久化消息格式 */
export interface PersistedGroupMessage {
  role: 'agent' | 'system' | 'tool' | 'error' | 'trigger';
  content: string | null;
  /** 消息来源 Agent ID */
  agent_id: string;
  /** 工具名称（tool 角色消息） */
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
}
