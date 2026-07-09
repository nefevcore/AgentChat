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
  FILE_UPLOAD: 'file.upload',
  FILE_UPLOAD_PROGRESS: 'file.upload.progress',
  FILE_UPLOAD_COMPLETE: 'file.upload.complete',

  // ---- 系统类 ----
  AGENT_LIST: 'agent.list',
  AGENT_LIST_RESPONSE: 'agent.list.response',
  HISTORY_REQUEST: 'history.request',
  HISTORY_RESPONSE: 'history.response',
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
]);
