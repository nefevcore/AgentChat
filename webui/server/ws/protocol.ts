// ============================================================
// WebSocket 消息协议定义
// 前端与 WebUI Server 之间的通信协议
// ============================================================

/**
 * WebSocket 消息类型常量
 */
export const WSMessageTypes = {
  // ---- 聊天类 ----
  CHAT_SEND: 'chat.send',
  CHAT_INTERRUPT: 'chat.interrupt',
  CHAT_INTERRUPTED: 'chat.interrupted',
  CHAT_START: 'chat.start',
  CHAT_END: 'chat.end',
  CHAT_TURN_START: 'chat.turn.start',
  CHAT_TURN_END: 'chat.turn.end',
  CHAT_MESSAGE_START: 'chat.message.start',
  CHAT_MESSAGE_UPDATE: 'chat.message.update',
  CHAT_MESSAGE_END: 'chat.message.end',
  CHAT_THINKING_START: 'chat.thinking.start',
  CHAT_THINKING_UPDATE: 'chat.thinking.update',
  CHAT_THINKING_END: 'chat.thinking.end',
  CHAT_TOOLCALL_START: 'chat.toolcall.start',
  CHAT_TOOLCALL_UPDATE: 'chat.toolcall.update',
  CHAT_TOOLCALL_END: 'chat.toolcall.end',
  CHAT_TOOL_EXECUTION_START: 'chat.tool_execution.start',
  CHAT_TOOL_EXECUTION_UPDATE: 'chat.tool_execution.update',
  CHAT_TOOL_EXECUTION_END: 'chat.tool_execution.end',

  // ---- 会话恢复类（重连）----
  CHAT_SUBSCRIBE: 'chat.subscribe',
  CHAT_SESSION_RESUME: 'chat.session.resume',

  // ---- 会话管理类 ----
  SESSION_ARCHIVE: 'session.archive',
  SESSION_ARCHIVED: 'session.archived',
  CHAT_DELETE_MESSAGE: 'chat.delete_message',
  FILE_UPLOAD: 'file.upload',
  FILE_UPLOAD_PROGRESS: 'file.upload.progress',
  FILE_UPLOAD_COMPLETE: 'file.upload.complete',

  // ---- System Prompt 预览 ----
  AGENT_SYSTEM_PROMPT: 'agent.system_prompt',
  AGENT_SYSTEM_PROMPT_RESPONSE: 'agent.system_prompt.response',

  // ---- 工具定义预览 ----
  AGENT_TOOL_DEFS: 'agent.tool_defs',
  AGENT_TOOL_DEFS_RESPONSE: 'agent.tool_defs.response',

  // ---- 系统类 ----
  AGENT_LIST: 'agent.list',
  AGENT_LIST_RESPONSE: 'agent.list.response',
  HISTORY_REQUEST: 'history.request',
  HISTORY_RESPONSE: 'history.response',

  // ---- 群聊类 ----
  ROOM_LIST: 'room.list',
  ROOM_LIST_RESPONSE: 'room.list.response',
  ROOM_CREATE: 'room.create',
  ROOM_CREATED: 'room.created',
  ROOM_DELETE: 'room.delete',
  ROOM_DELETED: 'room.deleted',
  ROOM_JOIN: 'room.join',
  ROOM_LEAVE: 'room.leave',
  ROOM_MESSAGE: 'room.message',
  ROOM_DELIVERED: 'room.delivered',
  ROOM_HISTORY_REQUEST: 'room.history.request',
  ROOM_HISTORY_RESPONSE: 'room.history.response',
} as const;

/**
 * WebSocket 消息格式
 */
export interface WSMessage {
  type: string;
  data: any;
}

/**
 * 验证消息是否为合法的 JSON WebSocket 消息
 */
export function parseWSMessage(raw: string): WSMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.type !== 'string') {
      return null;
    }
    return {
      type: parsed.type,
      data: parsed.data ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * 构建 WebSocket 消息
 */
export function buildWSMessage(type: string, data: any): string {
  return JSON.stringify({ type, data });
}

/**
 * 所有出站消息类型（服务端 → 前端）
 */
export const OutboundTypes = new Set([
  WSMessageTypes.CHAT_START,
  WSMessageTypes.CHAT_END,
  WSMessageTypes.CHAT_TURN_START,
  WSMessageTypes.CHAT_TURN_END,
  WSMessageTypes.CHAT_MESSAGE_START,
  WSMessageTypes.CHAT_MESSAGE_UPDATE,
  WSMessageTypes.CHAT_MESSAGE_END,
  WSMessageTypes.CHAT_THINKING_START,
  WSMessageTypes.CHAT_THINKING_UPDATE,
  WSMessageTypes.CHAT_THINKING_END,
  WSMessageTypes.CHAT_TOOLCALL_START,
  WSMessageTypes.CHAT_TOOLCALL_UPDATE,
  WSMessageTypes.CHAT_TOOLCALL_END,
  WSMessageTypes.CHAT_TOOL_EXECUTION_START,
  WSMessageTypes.CHAT_TOOL_EXECUTION_UPDATE,
  WSMessageTypes.CHAT_TOOL_EXECUTION_END,
  WSMessageTypes.CHAT_INTERRUPTED,
  WSMessageTypes.FILE_UPLOAD_PROGRESS,
  WSMessageTypes.FILE_UPLOAD_COMPLETE,
  WSMessageTypes.AGENT_LIST_RESPONSE,
  WSMessageTypes.HISTORY_RESPONSE,
  WSMessageTypes.ROOM_LIST_RESPONSE,
  WSMessageTypes.ROOM_CREATED,
  WSMessageTypes.ROOM_DELETED,
  WSMessageTypes.ROOM_MESSAGE,
  WSMessageTypes.ROOM_HISTORY_RESPONSE,
  WSMessageTypes.SESSION_ARCHIVED,
]);

/**
 * 所有入站消息类型（前端 → 服务端）
 */
export const InboundTypes = new Set([
  WSMessageTypes.CHAT_SEND,
  WSMessageTypes.CHAT_INTERRUPT,
  WSMessageTypes.FILE_UPLOAD,
  WSMessageTypes.AGENT_LIST,
  WSMessageTypes.HISTORY_REQUEST,
  WSMessageTypes.SESSION_ARCHIVE,
]);
