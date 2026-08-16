import type { MessageSource, PersistedMessage as SharedPersistedMessage, ToolCall as SharedToolCall, PluginMeta as SharedPluginMeta } from '@agentchat/protocol';

// ============================================================
// 前端 WebSocket 消息类型
// ============================================================

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  /** 头像 URL（可选） */
  avatar?: string | null;
  /** 最近活动时间戳（毫秒），用于排序 */
  lastActivity?: number;
  /** 最后一条消息的摘要 */
  lastMessage?: {
    role: string;
    content: string;
    timestamp: string;
    agent_id?: string;
  } | null;
  /** 是否有后台活跃会话（关闭页面后仍在执行） */
  hasActiveSession?: boolean;
  /** 是否为虚拟 Agent（无 LLM，仅作路由端点） */
  virtual?: boolean;
}

/** 思维链中的一个子步骤：一次 assistant thinking + 其触发的工具执行 */
export interface TurnStep {
  /** 发起工具调用的 assistant 消息（含 thinking + toolCalls） */
  assistant: ChatMessage;
  /** 匹配 tool_call_id 的工具执行结果 */
  tools: ChatMessage[];
  /** 是否仍在流式传输中 */
  isStreaming: boolean;
}

/** 一个完整的对话轮次：任意 Agent（含用户）的思考+回复 */
export interface Turn {
  agent_id: string;
  steps: TurnStep[];
  /** 最终纯文本回复（无 toolCalls 的 assistant），可为 null */
  final: ChatMessage | null;
}

/** ChatView 的渲染单元 */
export interface DisplayItem {
  type: 'turn' | 'time-separator' | 'event' | 'error';
  message?: ChatMessage;
  turn?: Turn;
  index: number;
  isStreaming?: boolean;
  timeText?: string;
}

/**
 * 插件元数据（跨端共享契约 + 启用状态）。
 * 基础契约来自 @agentchat/protocol（消除类型漂移）；
 * enabled 为 getAgentPlugins() 返回时附加的启用状态。
 */
export type PluginMeta = SharedPluginMeta & { enabled: boolean; description: string };

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
  virtual?: boolean;
  /** 能力标签（受控词汇表 base/dev/admin/conductor；base 隐式，旧 agent 归一化） */
  tags?: string[];
  /** 路径穿透白名单：允许此 Agent 的工具访问 workspaceDir 之外的路径 */
  allowedPaths?: string[];
  llm?: LLMConfig;
  /** 插件装配声明（工具 + 各阶段钩子；工具按 requires 自动注入，hooks 在此声明） */
  plugins?: Array<{
    name?: string;
    tools?: string[];
    runStart?: string[];
    runEnd?: string[];
    stepStart?: string[];
    stepEnd?: string[];
    toolExecutionStart?: string[];
    toolExecutionEnd?: string[];
    fallback?: string[];
  }>;
  [key: string]: any;
}

/**
 * 持久化消息（基础契约来自 @agentchat/protocol，role 含 event 与后端对齐）。
 * _meta 为前端展示私有字段（WS 实时消息包装），不影响持久化契约。
 */
export interface PersistedMessage extends SharedPersistedMessage {
  _meta?: {
    timestamp: string;
    from: string;
    to: string;
    correlation_id?: string;
    message_id?: string;
  };
}

/** 工具调用（来自 shared 契约，保持单源） */
export type ToolCall = SharedToolCall;

export interface ChatMessage {
  id: string;
  role: 'agent' | 'user' | 'tool' | 'event' | 'error';
  content: string;
  /** 持久化消息 ID，用于后端删除操作 */
  persistedMsgId?: string;
  /** 消息来源 Agent ID */
  agent_id?: string;
  /** 事件/入站消息来源元数据（event 分隔符渲染用） */
  source?: MessageSource;
  toolCalls?: ToolCall[];
  toolName?: string;
  tool_call_id?: string;
  name?: string;
  /** 工具调用参数（对象或 OpenAI 风格 JSON 字符串）；用于结果返回前渲染专用卡片 */
  arguments?: unknown;
  /** 思考过程（reasoning_content） */
  thinking?: string;
  /** 思考过程（别名，兼容 maid_webui 组件） */
  reasoning_content?: string;
  /** 思考标签（后端推送，含耗时信息） */
  label?: string;
  isStreaming?: boolean;
  status?: 'running' | 'success' | 'error';
  isError?: boolean;
  timestamp: number;
  files?: FileAttachment[];
  _archived_context?: boolean;
}

export interface FileAttachment {
  hash: string;
  filename: string;
  filesize: number;
  text?: string;
}

export interface WSIncoming {
  type: string;
  data: any;
}

// ============================================================
// 群组类型
// ============================================================

/** 群组信息（前端展示用） */
export interface GroupInfo {
  group_id: string;
  name: string;
  participants: string[];
  created_at: number;
  description?: string;
  /** 最近活动时间戳（毫秒），由前端 WS 消息驱动，与 Agent.lastActivity 统一排序 */
  lastActivity?: number;
}

/** 群组持久化消息（来自 API） */
export interface GroupPersistedMessage {
  role: string;
  content: string | null;
  agent_id: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  timestamp: string;
}
