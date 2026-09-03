// ============================================================
// api/wire.ts —— Port B 传输（preview 协议直连，阶段二第六梯完成体）
//
// 聊天面收口后的唯一 WS 通道：RPC（rpc/call + requestId 相关性 +
// 60s 超时）+ 事件帧订阅（type=事件名直转、args 按事件目录解包）+
// ws/ack（deliver busy/deduped 双通道）+ 断线自动重连（退避 2s→30s，
// onOpen 通知——feed 重连清理依赖）。
// 机制对齐归档原生面 wire/connection.ts（src WebSocketClient 同款
// 身份守卫/积压/看门狗语义的惰性形态：连接由首个消费者拉起）。
// ============================================================

type SocketCtor = typeof WebSocket;

let socketFactory: SocketCtor | null = null;

/** 保留注入点（测试/诊断）；收口后缺省即全局构造器 */
export function setWireSocketFactory(ctor: SocketCtor): void {
  socketFactory = ctor;
}

const RPC_CALL = 'rpc/call';
const RPC_RESULT = 'rpc/result';
const WS_ACK = 'ws/ack';
const WS_READY = 'ws/ready';
const RPC_TIMEOUT_MS = 60_000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

type EventHook = (type: string, args: unknown[]) => void;
type OpenHook = () => void;
type CloseHook = () => void;
type AckHook = (payload: { requestId: string; kind: string; info?: Record<string, unknown> }) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class WireRpcClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private queue: string[] = [];
  private connecting: Promise<WebSocket> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private eventHooks: EventHook[] = [];
  private openHooks: OpenHook[] = [];
  private closeHooks: CloseHook[] = [];
  private ackHooks: AckHook[] = [];

  /** 事件帧订阅（type=preview 事件名；args 参数序同事件目录） */
  onWireEvent(handler: EventHook): () => void {
    this.eventHooks.push(handler);
    this.socket().catch(() => undefined); // 有订阅即拉起连接（feed 启动即听流）
    return () => {
      const i = this.eventHooks.indexOf(handler);
      if (i >= 0) this.eventHooks.splice(i, 1);
    };
  }

  onWireOpen(handler: OpenHook): () => void {
    this.openHooks.push(handler);
    return () => {
      const i = this.openHooks.indexOf(handler);
      if (i >= 0) this.openHooks.splice(i, 1);
    };
  }

  onWireClose(handler: CloseHook): () => void {
    this.closeHooks.push(handler);
    return () => {
      const i = this.closeHooks.indexOf(handler);
      if (i >= 0) this.closeHooks.splice(i, 1);
    };
  }

  /** ws/ack 订阅（deliver busy/parked/deduped 双通道回执） */
  onWireAck(handler: AckHook): () => void {
    this.ackHooks.push(handler);
    return () => {
      const i = this.ackHooks.indexOf(handler);
      if (i >= 0) this.ackHooks.splice(i, 1);
    };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private socket(): Promise<WebSocket> {
    const existing = this.ws;
    if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (this.connecting) return this.connecting;
    const Ctor = socketFactory ?? WebSocket;
    const ws = new Ctor(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.ws = ws;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => {
        this.connecting = null;
        this.reconnectDelay = RECONNECT_BASE_MS;
        const q = this.queue;
        this.queue = [];
        for (const text of q) ws.send(text);
        for (const h of [...this.openHooks]) h();
        resolve(ws);
      };
      ws.onerror = () => {
        this.connecting = null;
        reject(new Error('WS 连接失败'));
      };
    });
    ws.onmessage = (ev: MessageEvent) => {
      let frame: { type?: unknown; data?: unknown };
      try {
        frame = JSON.parse(String(ev.data)) as { type?: unknown; data?: unknown };
      } catch {
        return;
      }
      const type = typeof frame.type === 'string' ? frame.type : '';
      if (!type || type === WS_READY) return;
      const data = frame.data ?? {};
      if (type === RPC_RESULT) {
        const d = data as { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown };
        const p = typeof d.requestId === 'string' ? this.pending.get(d.requestId) : undefined;
        if (!p) return;
        this.pending.delete(d.requestId as string);
        clearTimeout(p.timer);
        if (d.ok === true) p.resolve(d.result);
        else p.reject(new Error(typeof d.error === 'string' ? d.error : 'rpc 失败'));
        return;
      }
      if (type === WS_ACK) {
        const d = data as { requestId?: unknown; kind?: unknown; info?: unknown };
        if (typeof d.requestId !== 'string') return;
        for (const h of [...this.ackHooks]) {
          h({ requestId: d.requestId, kind: typeof d.kind === 'string' ? d.kind : '', ...(d.info && typeof d.info === 'object' ? { info: d.info as Record<string, unknown> } : {}) });
        }
        return;
      }
      // 事件帧：data.args 数组
      const args = Array.isArray((data as { args?: unknown }).args) ? (data as { args: unknown[] }).args : [];
      for (const h of [...this.eventHooks]) {
        try {
          h(type, args);
        } catch (err) {
          console.error(`[wire] 事件处理器出错（${type}）:`, err);
        }
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.connecting = null;
      this.failAll(new Error('WS 连接已断开'));
      for (const h of [...this.closeHooks]) h();
      this.scheduleReconnect();
    };
    return this.connecting;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, RECONNECT_MAX_MS);
      this.socket().catch(() => undefined); // 失败由 onclose 再次排程
    }, this.reconnectDelay);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>, requestId?: string, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
    await this.socket();
    this.seq += 1;
    const id = requestId ?? `b-${this.seq}-${Date.now().toString(36)}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const text = JSON.stringify({ type: RPC_CALL, data: { method, requestId: id, ...(params !== undefined ? { params } : {}) } });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
    return promise as Promise<T>;
  }
}

/** Port B RPC/事件单例（全模块共用一条连接） */
export const wireRpc = new WireRpcClient();
