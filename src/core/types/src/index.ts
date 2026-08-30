// ============================================================
// @agentchat/types —— AgentChat 核心域契约（零运行时依赖）
//
// 统一消息/工具定义/流式回调/消息来源等跨包共享契约。
// MessageSource 等来源契约已从 src/shared/types 收编进本包；
// 跨端/持久化 DTO 归 @agentchat/protocol（protocol 从本包 type-import）。
// 铁律：本文件不 import 任何运行时模块，仅声明类型。
// ============================================================

/**
 * 消息来源 kind：回答"谁产生了这条入站消息"。
 * 与角色（role，LLM 传输语义）正交；Agent 间身份仍由 agent_id 表达。
 */
export type MessageSourceKind =
  /** 人类用户输入 */
  | 'user'
  /** 另一个 Agent 发来的消息（send_agent / 群发等） */
  | 'agent'
  /** 运行时/系统注入（通用兜底） */
  | 'system'
  /** 定时器触发 */
  | 'timer'
  /** 群聊事件触发 */
  | 'group'
  /** 子 Agent 输出/通知 */
  | 'subagent'
  /** chat.continue 自我续推（continue_turn 工具已于 v0.7.1 移除） */
  | 'continue'
  /** 重启后自动恢复 */
  | 'restart'
  /** 归档整理 run */
  | 'archive';

/** 消息来源 form：回答"这是一条什么形态的信息"。 */
export type MessageForm =
  /** 普通对话输入 */
  | 'prompt'
  /** 系统/事件给出的引导提示（原 trigger hint） */
  | 'hint'
  /** 一次性事件通知（后台任务完成等，DSH 式 notice） */
  | 'notice'
  /** 恢复/继续会话的系统信号 */
  | 'resume'
  /** Agent 间转述的消息 */
  | 'relay';

/** 入站消息的来源元数据（前端渲染 / 持久化 / 日志共用）。 */
export interface MessageSource {
  kind: MessageSourceKind;
  form?: MessageForm;
  /** 一行摘要：前端分隔符与活动记录展示用；缺省由 UI 从 content 截断 */
  summary?: string;
  /** 关联消息 ID：群聊触发时 = 落盘行的 message_id（去重/锚点定位用） */
  message_id?: string;
  /** 旧 role='trigger' 数据归一化时保留的诊断标记 */
  legacyRole?: 'trigger';
}

/**
 * 消息角色（内存/LLM 传输格式）。
 * 入站消息统一 role='user'，来源语义由 source.kind/form/summary 表达；
 * role='agent' 为持久化发言格式（归属由 agent_id 标记，provider 依据 viewer 做视角转换）。
 * 旧 role='trigger' 已移除；持久化的事件角色是 PersistedRole='event'（见 @agentchat/protocol）。
 */
export type MessageRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'agent';

/** inbox 投递 lane：next-turn = 当前 run 结束后的独立后续 run；next-step = 当前 run 下一 ReAct step */
export type DeliveryLane = 'next-turn' | 'next-step';

/**
 * 消息投递调度元数据（router 排队/唤醒使用；不序列化进 LLM 请求与持久化文件）。
 */
export interface MessageDelivery {
  /** 投递 lane（缺省 next-step） */
  lane?: DeliveryLane;
  /** 是否允许在会话空闲时唤醒新 run（inject=false 只入队挂起） */
  wakeup?: boolean;
  /** 独立自主 run 的最大 ReAct 步数（next-turn 消费时生效） */
  maxSteps?: number;
}

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
 * role='agent' 为持久化发言格式（归属由 agent_id 标记，provider 依据 viewer 做视角转换）。
 * role='user' 且带 source 的入站消息为系统/事件触发（原 trigger 语义），
 * 持久化时由 toPersistedRole 映射为 role='event' + source。
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
  /**
   * 投递调度元数据（router inbox 排队/唤醒用）。
   * 不进 LLM 请求、不落盘：toProviderMessages/toPersisted 均显式忽略。
   */
  delivery?: MessageDelivery;
  /**
   * 入站消息来源元数据（事件触发消息必有；普通用户/Agent 发言可选）。
   * 来源分类见 MessageSourceKind/MessageForm（user/agent/timer/group/subagent/
   * continue/restart/archive × prompt/hint/notice/resume/relay）。
   */
  source?: MessageSource;
}

/**
 * LLM 请求消息 —— 与 AgentMessage 同构。
 * 由 provider 的 toProviderMessages 负责角色解析（error→tool、agent 视角转换）；
 * 持久化 role='event' 与旧 role='trigger' 在 loadHistory 读取时已归一化为 user + source。
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

/**
 * 判断一次 run 是否属于“后台/系统注入”会话。
 *
 * 与持久化 event 消息的 source 语义对齐：
 *   · form = hint / resume / notice → 自主推理或系统注入，WS/前端不作为前台流广播/渲染；
 *   · form = prompt / relay         → 人机对话与 Agent 间转述，前台可见；
 *   · 缺省 form 的旧数据按 kind 兜底（timer/group/subagent/continue/restart/archive）。
 *
 * 替代旧 isTrigger 布尔投影：分类依据是 MessageSource，而不是“有无 currentMessage”。
 */
export function isBackgroundRunSource(source?: MessageSource): boolean {
  if (!source) return false;
  switch (source.form) {
    case 'hint':
    case 'resume':
    case 'notice':
      return true;
    case 'prompt':
    case 'relay':
      return false;
  }
  return source.kind === 'timer'
    || source.kind === 'group'
    || source.kind === 'subagent'
    || source.kind === 'continue'
    || source.kind === 'restart'
    || source.kind === 'archive';
}
