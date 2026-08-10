// ============================================================
// domain/types.ts —— 纯数据模型（零 UI 依赖）
//
// 铁律：
// 1. 本文件（及整个 domain/ 目录）不 import 任何 Vue/Pinia/DOM 模块；
// 2. 只描述"会话数据长什么样"，不含任何渲染状态
//    （isStreaming/status/isError/展开折叠 等瞬态一律放 view 层 runtime）；
// 3. 跨端共享的契约直接复用 @shared/types，避免二次漂移。
// ============================================================

import type {
  PersistedMessage as SharedPersistedMessage,
  ToolCall as SharedToolCall,
  PluginMeta as SharedPluginMeta,
  GroupInfo as SharedGroupInfo,
  GroupPersistedMessage as SharedGroupPersistedMessage,
} from '@shared/types';

// ── 消息角色（domain 层定义，跨 agent/group 会话统一）──
export type MessageRole = 'agent' | 'tool' | 'trigger' | 'system';

/** 流式运行时状态（消息当前传输/执行情况，数据层瞬态） */
export interface MessageRuntime {
  /** 是否仍在流式接收 */
  isStreaming?: boolean;
  /** 工具执行状态 */
  status?: 'running' | 'success' | 'error';
  /** 是否为错误消息 */
  isError?: boolean;
}

/**
 * 单条会话消息（纯数据）。
 * 只描述"已经是什么"的事实 + 流式瞬态（正在发生什么）；
 * 不含任何 UI 布局/展示概念（展开折叠/宽度/主题等）。
 */
export interface ChatMessage {
  /** 前端会话内唯一 ID（用于 diff/定位） */
  id: string;
  role: MessageRole;
  /** 消息正文（纯文本 / JSON 工具结果字符串） */
  content: string;
  /** 持久化消息 ID（后端删除操作使用） */
  persistedMsgId?: string;
  /** 消息来源 Agent ID（多 Agent 会话辨识归属；'user' = 本机用户） */
  agent_id?: string;
  /** 工具调用（assistant 消息，OpenAI 原生格式） */
  toolCalls?: SharedToolCall[];
  /** 工具名（tool 角色消息） */
  toolName?: string;
  /** 工具调用 ID（tool 角色消息，与 toolCalls 配对） */
  tool_call_id?: string;
  /** 工具显示名（后端推送 label） */
  name?: string;
  /** 思维链（reasoning_content 别名，双写兼容） */
  thinking?: string;
  /** 思维链（后端推送字段） */
  reasoning_content?: string;
  /** 思考标签（后端推送，含耗时信息） */
  label?: string;
  /** 毫秒时间戳 */
  timestamp: number;
  /** 附件 */
  files?: FileAttachment[];
  // ── 流式瞬态（数据运行时状态，非 UI 概念）──
  isStreaming?: boolean;
  status?: MessageRuntime['status'];
  isError?: boolean;
}

/** 附件 */
export interface FileAttachment {
  hash: string;
  filename: string;
  filesize: number;
  /** 服务器相对路径 */
  text?: string;
}

/** 思维链中的一个子步骤：一次 assistant thinking + 其触发的工具执行 */
export interface TurnStep {
  assistant: ChatMessage;
  tools: ChatMessage[];
  /** 该步骤是否仍在流式接收 */
  isStreaming?: boolean;
}

/** 一个完整的对话轮次：任意 Agent（含用户）的思考+回复 */
export interface Turn {
  agent_id: string;
  steps: TurnStep[];
  /** 最终纯文本回复（无 toolCalls 的 assistant），可为 null */
  final: ChatMessage | null;
}

/**
 * Agent 公开信息（列表/头像/名称）。
 * 注意：后端 WS 返回的字段是 `id`（非 shared 的 agent_id），
 * 因此这里以真实传输契约为准独立定义，不复用 shared 的 AgentInfo。
 */
export interface AgentInfo {
  /** Agent ID（后端 agent.list.response 返回字段） */
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  tags?: string[];
  virtual?: boolean;
  /** 前端附加的最近活动时间戳（毫秒），用于排序 */
  lastActivity?: number;
  /** 最后一条消息摘要 */
  lastMessage?: {
    role: string;
    content: string;
    timestamp: string;
    agent_id?: string;
  } | null;
  /** 是否有后台活跃会话 */
  hasActiveSession?: boolean;
}

/** 群组信息 */
export interface GroupInfo extends SharedGroupInfo {
  /** 最近活动时间戳（毫秒），由前端 WS 消息驱动 */
  lastActivity?: number;
}

/** 会话引用：统一 agent 会话与群聊的身份标识 */
export type ConversationRef =
  | { kind: 'agent'; id: string }
  | { kind: 'group'; id: string };

// ── 跨端契约 re-export（单源，防止漂移）──
export type PersistedMessage = SharedPersistedMessage;
export type ToolCall = SharedToolCall;
export type PluginMeta = SharedPluginMeta;
export type GroupPersistedMessage = SharedGroupPersistedMessage;

// ── 群组历史消息（API 返回格式，映射为 ChatMessage 的原料）──
export interface GroupHistoryMessage {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: SharedToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
}

/** LLM 配置（前端编辑用） */
export interface LLMConfig {
  provider: 'openai' | 'deepseek' | 'ollama';
  api_key: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: 'high' | 'max';
  thinking?: boolean;
}

/** Agent 完整配置（前端编辑用） */
export interface AgentFullConfig {
  agent_id: string;
  name: string;
  description?: string;
  virtual?: boolean;
  tags?: string[];
  allowedPaths?: string[];
  llm?: LLMConfig;
  [key: string]: any;
}
