// ============================================================
// WebSocket 客户端服务
// ============================================================

export type MessageHandler = (type: string, data: any) => void;
export type ConnectHandler = () => void;

import { logger } from '../utils/logger';

/** 待发队列上限：断线期间堆积的发送指令封顶（防"幽灵消息"与内存无界增长） */
const MAX_PENDING = 100;
/** 僵死连接探测间隔：超过该时长未收到任何入站消息即认定半开，主动 close
 *  走重连（浏览器在 NAT 静默超时/睡眠唤醒后不触发 onclose，readyState 恒
 *  OPEN，表现为"发消息没反应，刷新才好"——后端有 30s 协议层 ping，正常
 *  连接必有周期性入站帧，不会误杀） */
const IDLE_TIMEOUT_MS = 90_000;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: MessageHandler[] = [];
  private connectHandlers: ConnectHandler[] = [];
  private disconnectHandlers: ConnectHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private pendingMessages: { type: string; data: any }[] = [];
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;

  constructor(url?: string) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url ?? `${protocol}//${location.host}/ws`;
  }

  /** 半开连接看门狗：周期检查入站活跃度，僵死连接主动 close 触发重连 */
  private startIdleWatch(): void {
    this.stopIdleWatch();
    this.lastInboundAt = Date.now();
    this.idleTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastInboundAt > IDLE_TIMEOUT_MS) {
        logger.warn('[WS Client] 连接静默超时（疑似半开），主动断开重连');
        // 置空事件后 close：onclose 走正常重连路径（身份守卫放行当前 socket）
        ws.close();
      }
    }, 15_000);
  }

  private stopIdleWatch(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    // CLOSING 也直接放行重建（旧 socket 事件已被身份守卫隔离），避免 send
    // 在 CLOSING 窗口排队后 connect 早退、消息滞留队列

    logger.info(`[WS Client] 正在连接到 ${this.url}…`);
    // 身份守卫：重连/替换 socket 后，旧 socket 迟到的 close/error/open 事件
    // 一律忽略——否则旧 socket 的 onclose 会把 connected 错误置 false（新连接
    // 实际存活，UI 卡在"已断开"），disconnect() 后的 close 还会触发意外重连。
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      logger.info('[WS Client] 已连接');
      this.reconnectDelay = 2000;
      this.startIdleWatch();
      // 通知连接成功
      for (const handler of this.connectHandlers) {
        handler();
      }
      // 连接成功后发送所有待发消息
      this.flushPending();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      try {
        const msg = JSON.parse(event.data);
        for (const handler of this.handlers) {
          handler(msg.type, msg.data);
        }
      } catch (err) {
        logger.warn('[WS Client] 解析消息失败：', event.data);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // 过期 socket 的关闭：不影响当前连接状态
      logger.info('[WS Client] 已断开，正在重连…');
      this.ws = null;
      this.stopIdleWatch();
      for (const handler of this.disconnectHandlers) {
        handler();
      }
      this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      if (this.ws !== ws) return;
      logger.error('[WS Client] 错误：', err);
    };
  }

  /** 发送连接建立前的积压消息 */
  private flushPending(): void {
    if (this.pendingMessages.length === 0) return;
    // 先整体取走队列再逐条发送：
    //   ① 单条失败（payload 无法 JSON 序列化——循环引用/BigInt 等，入队时
    //      不序列化、只有此处 send 才爆炸；或连接瞬断 send 抛 InvalidState）
    //      不能把异常抛出 onopen——否则 `pendingMessages = []` 永不执行，
    //      毒消息永久滞留队列，每次重连都重复「正在发送 N 条积压消息」→
    //      再失败 → 无限复读（用户实报「一条积压消息一直积压没有发送」）；
    //   ② 发送过程中新入队的消息进入新队列（下次连接 flush），不会被误清。
    const queue = this.pendingMessages;
    this.pendingMessages = [];
    // 带消息类型：页面加载竞态（握手期发的 agent.list）flush 属正常路径，
    // 类型可直接区分「良性 1 条」与异常堆积，无需翻调用方
    const preview = queue.slice(0, 5).map(m => m.type).join(', ');
    const suffix = queue.length > 5 ? ` 等 ${queue.length} 条` : '';
    logger.info(`[WS Client] 正在发送 ${queue.length} 条积压消息（${preview}${suffix}）`);
    for (const msg of queue) {
      try {
        this.send(msg.type, msg.data);
      } catch (err) {
        // 毒消息丢弃（重试永远失败），ERROR 带类型可诊断；不影响同批其余消息
        logger.error(`[WS Client] 积压消息发送失败（type=${msg.type}），已丢弃:`, err);
      }
    }
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
      // 连接中，暂存消息等待连接成功后发送（上限防泄漏：长时间断线堆积无界）
      this.enqueuePending(type, data);
    } else {
      // 未连接，先连接再暂存
      logger.warn('[WS Client] 未连接，正在排队消息并重连');
      this.enqueuePending(type, data);
      this.connect();
    }
  }

  /** 待发队列（带上限）：超出丢最旧并告警——断线数小时的页面重连时不应
   *  flush 一大批过时指令（"幽灵消息"：用户早已重发/放弃的内容被补发）。 */
  private enqueuePending(type: string, data: any): void {
    if (this.pendingMessages.length >= MAX_PENDING) {
      logger.warn(`[WS Client] 待发队列已满（${MAX_PENDING}），丢弃最旧消息`);
      this.pendingMessages.shift();
    }
    this.pendingMessages.push({ type, data });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  offMessage(handler: MessageHandler): void {
    const idx = this.handlers.indexOf(handler);
    if (idx >= 0) this.handlers.splice(idx, 1);
  }

  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.push(handler);
    if (this.ws?.readyState === WebSocket.OPEN) {
      handler();
    }
    return () => {
      const idx = this.connectHandlers.indexOf(handler);
      if (idx >= 0) this.connectHandlers.splice(idx, 1);
    };
  }

  onDisconnect(handler: ConnectHandler): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      const idx = this.disconnectHandlers.indexOf(handler);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopIdleWatch();
    // 先摘事件再 close：close 是异步握手，残留的 onclose 随后触发会
    // ① 通知全部 disconnectHandlers ② scheduleReconnect 自动"复活"——
    // 复活的新连接 handlers 未清（此前清的是 handlers，方向反了）→ 全聋。
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    this.ws = null;
    this.pendingMessages = [];
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
