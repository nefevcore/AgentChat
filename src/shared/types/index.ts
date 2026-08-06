// ============================================================
// shared/types —— 跨端共享类型契约（v0.5.0 架构重构 P0）
//
// 位于 src/shared/ 的跨端契约包（前端/后端/TUI/Desktop 共用），
// 消除"两端各维护一份类型导致漂移"的问题（如 PersistedMessage role 不一致）。
//
// 判断标准：前端已复制一份的类型 = 跨端共享（进这里）；
// 只 src 内部用的核心契约（LLMRequest/AgentContext/hooks）留在 src/core/types。
// ============================================================

/** 消息角色（持久化格式；与 src 扩展 agent-session/types 对齐，含 trigger） */
export type PersistedRole = 'agent' | 'system' | 'tool' | 'error' | 'trigger';

/** 工具调用（OpenAI 原生格式，前后端通用） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 持久化消息（会话文件 messages.jsonl 的一行） */
export interface PersistedMessage {
  role: PersistedRole;
  content: string | null;
  /** 消息来源 Agent ID（多 Agent 会话中辨识归属） */
  agent_id?: string;
  /** 工具名称（tool 角色消息提供） */
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  /** 展示标签（工具调用/思考标签） */
  label?: string;
  /** 消息唯一标识（前端定位与删除） */
  message_id?: string;
  /** 原始时间戳（归档时不重写） */
  timestamp?: string;
  /** 前端展示附加元数据（_meta 归前端私有，不进 shared？——见下方说明） */
}

/** Agent 公开信息（列表/档案展示用） */
export interface AgentInfo {
  agent_id: string;
  name: string;
  description?: string;
  avatar?: string;
  tags?: string[];
  virtual?: boolean;
  llm?: { provider?: string; model?: string };
  lastMessage?: string;
}

/** 群组信息 */
export interface GroupInfo {
  group_id: string;
  name: string;
  description?: string;
  participants: string[];
  avatar?: string;
}

/** 群组持久化消息 */
export interface GroupPersistedMessage {
  group_id: string;
  role: PersistedRole;
  content: string | null;
  agent_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  label?: string;
  message_id?: string;
  timestamp?: string;
}

/**
 * 插件元数据（加载后，跨端共享）—— 前端展示 / 后端 getAllPlugins 共用。
 *
 * 单一来源：前端 webui/client 不再各自维护副本（消除 P0 类型漂移）。
 * getAgentPlugins() 返回时附加 enabled（启用状态）。
 */
export interface PluginMeta {
  /** 插件/工具/扩展唯一标识 */
  name: string;
  /** 类型：tool / pre_hook / post_hook */
  type: 'tool' | 'pre_hook' | 'post_hook';
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
  /** 条件显示（配置面板用） */
  showWhen?: Record<string, string | number | boolean>;
  /** 是否自动注入所有 Agent */
  autoInject?: boolean;
  /** 工具层级（basic/tool/dev/admin，兼容旧字段） */
  level?: 'basic' | 'tool' | 'dev' | 'admin';
  /** 能力标签要求（AND 语义） */
  requires?: string[];
  /** 是否隐藏（不参与发现流程） */
  hidden?: boolean;
  /** 来源 Agent ID（Agent 专属插件；全局插件为 undefined） */
  agentId?: string;
}

/** LLM 配置（池条目展开后） */
export interface LLMConfig {
  provider?: string;
  model?: string;
  api_key?: string;
  base_url?: string;
  default?: boolean;
  [key: string]: unknown;
}

/** Agent 完整配置（设置面板读写） */
export interface AgentFullConfig {
  agent_id: string;
  name: string;
  description?: string;
  persona?: string;
  avatar?: string;
  tags?: string[];
  virtual?: boolean;
  llm?: LLMConfig | string;
  pre_hooks?: string[];
  post_hooks?: string[];
  allowedPaths?: string[];
  [key: string]: unknown;
}

/** WebSocket 入站消息（前端协议层） */
export interface WSIncoming {
  type: string;
  data?: any;
  [key: string]: any;
}
