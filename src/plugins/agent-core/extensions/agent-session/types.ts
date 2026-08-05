// ============================================================
// agent-session types —— 持久化消息格式
// ============================================================

/** 持久化消息格式（agent-session 插件独有） */
export interface PersistedMessage {
  role: 'agent' | 'system' | 'tool' | 'error' | 'trigger';
  content: string | null;
  /** 消息唯一标识，用于前端定位与删除 */
  message_id?: string;
  /** 消息来源 Agent ID，用于多 Agent 会话中辨识消息归属 */
  agent_id?: string;
  /** 工具名称（tool 角色消息必须提供） */
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  /** 思维链/推理内容 */
  reasoning_content?: string;
  /** 展示标签（工具调用如 "[read] 读取 /path/to/file"，思考如 "已思考（用时 3 秒）"） */
  label?: string;
  timestamp: string;
}
