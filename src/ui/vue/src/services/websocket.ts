// ============================================================
// WebSocket 客户端服务
// ============================================================

export type MessageHandler = (type: string, data: any) => void;
export type ConnectHandler = () => void;

import { logger } from '../utils/logger';

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: MessageHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private disconnectHandlers: ConnectHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private pendingMessages: { type: string; data: any }[] = [];

  constructor(url?: string) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url ?? `${protocol}//${location.host}/ws`;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws?.readyState === WebSocket.CONNECTING) return;

    logger.info(`[WS Client] 正在连接到 ${this.url}…`);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      logger.info('[WS Client] 已连接');
      this.reconnectDelay = 2000;
      // 通知连接成功
      for (const handler of this.connectHandlers) {
        handler();
      }
      // 连接成功后发送所有待发消息
      this.flushPending();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        for (const handler of this.handlers) {
          handler(msg.type, msg.data);
        }
      } catch (err) {
        logger.warn('[WS Client] 解析消息失败：', event.data);
      }
    };

    this.ws.onclose = () => {
      logger.info('[WS Client] 已断开，正在重连…');
      for (const handler of this.disconnectHandlers) {
        handler();
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      logger.error('[WS Client] 错误：', err);
    };
  }

  /** 发送连接建立前的积压消息 */
  private flushPending(): void {
    if (this.pendingMessages.length === 0) return;
    logger.info(`[WS Client] 正在发送 ${this.pendingMessages.length} 条积压消息`);
    for (const msg of this.pendingMessages) {
      this.send(msg.type, msg.data);
    }
    this.pendingMessages = [];
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  send(type: string, data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      // 连接中，暂存消息等待连接成功后发送
      this.pendingMessages.push({ type, data });
    } else {
      // 未连接，先连接再暂存
      logger.warn('[WS Client] 未连接，正在排队消息并重连');
      this.pendingMessages.push({ type, data });
      this.connect();
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onConnect(handler: ConnectHandler): void {
    this.connectHandlers.push(handler);
    if (this.ws?.readyState === WebSocket.OPEN) {
      handler();
    }
  }

  onDisconnect(handler: ConnectHandler): void {
    this.disconnectHandlers.push(handler);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.handlers = [];
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
