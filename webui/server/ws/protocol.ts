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
  CHAT_RESPONSE_START: 'chat.response.start',
  CHAT_RESPONSE_CHUNK: 'chat.response.chunk',
  CHAT_RESPONSE_DONE: 'chat.response.done',
  CHAT_THINKING_START: 'chat.thinking.start',
  CHAT_THINKING_CHUNK: 'chat.thinking.chunk',
  CHAT_THINKING_DONE: 'chat.thinking.done',
  CHAT_TOOL_START: 'chat.tool.start',
  CHAT_TOOL_DONE: 'chat.tool.done',

  // ---- 文件类 ----
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
  WSMessageTypes.CHAT_RESPONSE_START,
  WSMessageTypes.CHAT_RESPONSE_CHUNK,
  WSMessageTypes.CHAT_RESPONSE_DONE,
  WSMessageTypes.CHAT_THINKING_START,
  WSMessageTypes.CHAT_THINKING_CHUNK,
  WSMessageTypes.CHAT_THINKING_DONE,
  WSMessageTypes.CHAT_TOOL_START,
  WSMessageTypes.CHAT_TOOL_DONE,
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
