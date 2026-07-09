// ============================================================
// 前端 WebSocket 消息类型
// ============================================================

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  /** 最近活动时间戳（毫秒），用于排序 */
  lastActivity?: number;
  /** 最后一条消息的摘要 */
  lastMessage?: {
    role: string;
    content: string;
    timestamp: string;
  } | null;
  /** 是否有后台活跃会话（关闭页面后仍在执行） */
  hasActiveSession?: boolean;
}

/** 插件元数据（前端展示用） */
export interface PluginInfo {
  /** 插件唯一标识 */
  name: string;
  /** 插件类型 */
  type: 'tool' | 'pre_hook' | 'post_hook';
  /** 功能描述 */
  description: string;
  /** UI 展示名称 */
  displayName?: string;
  /** 是否已启用 */
  enabled: boolean;
}

export interface PersistedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** 消息来源 Agent ID */
  agent_id?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  /** 展示标签（工具调用如 "[read] 读取 /path/to/file"，思考如 "已思考（用时 3 秒）"） */
  label?: string;
  _meta?: {
    timestamp: string;
    from: string;
    to: string;
    correlation_id?: string;
    message_id?: string;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** 消息来源 Agent ID */
  agent_id?: string;
  toolCalls?: ToolCall[];
  toolName?: string;
  tool_call_id?: string;
  name?: string;
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
