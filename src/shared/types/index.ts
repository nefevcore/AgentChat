// ============================================================
// src/shared/types —— 跨端共享类型契约（零依赖，谁都能引）
//
// webui/TUI/Desktop/后端 services 共用的跨端契约，消除"两端各维护
// 一份类型导致漂移"的问题（如 PersistedMessage role 不一致）。
//
// 判断标准：前端已复制一份的类型 = 跨端共享（进这里）；
// 只 src 内部用的核心契约（LLMRequest/AgentContext/hooks）留在 src/core/types。
//
// 铁律：本文件零依赖（不 import 任何模块），仅声明类型。
// ============================================================

/** 消息角色（持久化格式；与 builtin hooks/session toPersistedRole 对齐，含 trigger） */
export type PersistedRole = 'agent' | 'system' | 'tool' | 'error' | 'trigger';

/** 工具调用（OpenAI 原生格式，前后端通用；arguments 为 JSON 字符串） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 持久化消息（1:1 会话文件 messages.jsonl 的一行） */
export interface PersistedMessage {
  role: PersistedRole;
  content: string | null;
  /** 消息来源 Agent ID（多 Agent 会话中辨识归属） */
  agent_id?: string;
  /** 工具名称（tool 角色消息提供） */
  name?: string;
  /** 工具调用 ID（tool 角色消息，与 assistant.tool_calls 配对） */
  tool_call_id?: string;
  /** 工具调用（assistant 消息，OpenAI 原生格式） */
  tool_calls?: ToolCall[];
  /** 思维链/推理内容（DeepSeek reasoning_content） */
  reasoning_content?: string;
  /** UI 展示标签 */
  label?: string;
  /** 消息唯一标识（前端定位与删除） */
  message_id?: string;
  /** 原始时间戳（归档时不重写） */
  timestamp?: string;
}

/** Agent 公开信息（列表/档案展示用） */
export interface AgentInfo {
  agent_id: string;
  name: string;
  description?: string;
  avatar?: string;
  tags?: string[];
  /** 虚拟 Agent（user 端点，无 LLM） */
  virtual?: boolean;
  llm?: { provider?: string; model?: string };
}

/** 群组信息 */
export interface GroupInfo {
  group_id: string;
  name: string;
  description?: string;
  participants: string[];
}

/** 群组持久化消息（groups/<id>/messages.jsonl 的一行） */
export interface GroupPersistedMessage {
  /** 所属群组 ID（可选，便于前端聚合） */
  group_id?: string;
  role: PersistedRole;
  content: string;
  agent_id?: string;
  name?: string;
  label?: string;
  message_id?: string;
  timestamp?: string;
}

/** 插件元数据（跨端共享；前端 PluginSettings 等展示用） */
export interface PluginMeta {
  /** 插件唯一标识 */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
  /** 类型（兼容旧字段；新架构统一 'plugin'） */
  type?: string;
  /** 是否启用（getAgentPlugins 返回时附加） */
  enabled?: boolean;
  [key: string]: unknown;
}
