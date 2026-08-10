// ============================================================
// domain/protocol.ts —— WS 消息类型常量 + 出站/入站清单
// 与后端 src/server/ws/protocol.ts 对齐（v2 独立维护，单向契约）
// ============================================================

export const WSMessageTypes = {
  // 聊天类
  CHAT_SEND: 'chat.send',
  CHAT_SEND_ACK: 'chat.send.ack',
  CHAT_INTERRUPT: 'chat.interrupt',
  CHAT_CONTINUE: 'chat.continue',
  CHAT_INTERRUPTED: 'chat.interrupted',
  CHAT_START: 'chat.start',
  CHAT_END: 'chat.end',
  CHAT_TURN_START: 'chat.turn.start',
  CHAT_TURN_END: 'chat.turn.end',
  CHAT_MESSAGE_START: 'chat.message.start',
  CHAT_MESSAGE_UPDATE: 'chat.message.update',
  CHAT_MESSAGE_END: 'chat.message.end',
  CHAT_MESSAGE_ERROR: 'chat.message.error',
  CHAT_THINKING_START: 'chat.thinking.start',
  CHAT_THINKING_UPDATE: 'chat.thinking.update',
  CHAT_THINKING_END: 'chat.thinking.end',
  CHAT_TOOLCALL_START: 'chat.toolcall.start',
  CHAT_TOOLCALL_UPDATE: 'chat.toolcall.update',
  CHAT_TOOLCALL_END: 'chat.toolcall.end',
  CHAT_TOOL_EXECUTION_START: 'chat.tool_execution.start',
  CHAT_TOOL_EXECUTION_UPDATE: 'chat.tool_execution.update',
  CHAT_TOOL_EXECUTION_END: 'chat.tool_execution.end',

  // 会话恢复
  CHAT_SUBSCRIBE: 'chat.subscribe',
  CHAT_SESSION_RESUME: 'chat.session.resume',

  // 会话管理
  SESSION_COMPRESS: 'session.compress',
  SESSION_COMPRESSED: 'session.compressed',
  SESSION_ARCHIVED: 'session.archived',
  CHAT_DELETE_MESSAGE: 'chat.delete_message',

  // 交互类（ask_questions）
  CHAT_INTERACTION: 'chat.interaction',
  CHAT_INTERACT_RESPOND: 'chat.interact.respond',

  // System Prompt / 工具定义预览
  AGENT_SYSTEM_PROMPT: 'agent.system_prompt',
  AGENT_SYSTEM_PROMPT_RESPONSE: 'agent.system_prompt.response',
  AGENT_TOOL_DEFS: 'agent.tool_defs',
  AGENT_TOOL_DEFS_RESPONSE: 'agent.tool_defs.response',

  // 系统类
  AGENT_LIST: 'agent.list',
  AGENT_LIST_RESPONSE: 'agent.list.response',
  AGENT_PROFILE_UPDATED: 'agent.profile.updated',
  HISTORY_REQUEST: 'history.request',
  HISTORY_RESPONSE: 'history.response',

  // 群组类
  GROUP_LIST: 'group.list',
  GROUP_LIST_RESPONSE: 'group.list.response',
  GROUP_CREATE: 'group.create',
  GROUP_CREATED: 'group.created',
  GROUP_DELETE: 'group.delete',
  GROUP_DELETED: 'group.deleted',
  GROUP_JOIN: 'group.join',
  GROUP_LEAVE: 'group.leave',
  GROUP_MESSAGE: 'group.message',

  // 系统重启
  SYSTEM_RESTART: 'system.restart',
  SYSTEM_RESTARTING: 'system.restarting',
} as const;

export type WSMessageType = (typeof WSMessageTypes)[keyof typeof WSMessageTypes];

export interface WSMessage {
  type: string;
  data: any;
}

export function parseWSMessage(raw: string): WSMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.type !== 'string') return null;
    return { type: parsed.type, data: parsed.data ?? {} };
  } catch {
    return null;
  }
}

export function buildWSMessage(type: string, data: any): string {
  return JSON.stringify({ type, data });
}
