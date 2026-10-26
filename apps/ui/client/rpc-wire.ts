// ============================================================
// rpc-wire.ts —— 浏览器 rpcWire 真面（8.5e）
//
// 主线 webui/src/api/wire.ts 的 preview 平移（wireRpc 单例语义——
// rpc-host.ts RpcWire 注入面的浏览器实现）：
//   · 单 WS 通道 /ws：rpc/call + requestId 相关性 + 超时；
//   · 事件帧解包直转（批帧 llm/delta-batch 展开为逐帧 llm/delta——
//     feed-core 消费面，主线 wire.ts 同款）；
//   · 断线重连（退避 2s→30s，onOpen 通知）；
//   · 身份守卫（isCurrent——被顶替连接的迟到回调一律忽略）。
// 主线终态 = apps/ui/src/api/wire.ts 整体平移进 ac-webui 单包
// client/ 半边（cutover 收编本文件——ui-tree §4）。
// ============================================================
import { unpackWireFrames } from 'ac-wire-format';
import { RPC_CALL, RPC_RESULT, WS_ACK } from 'ac-ws-protocol';

type SocketCtor = typeof WebSocket;

let socketFactory: SocketCtor | null = null;

/** 注入点（测试/诊断）；缺省 = 全局构造器 */
export function setWireSocketFactory(ctor: SocketCtor): void {
  socketFactory = ctor;
}

const RPC_TIMEOUT_MS = 60_000;
export const RECONNECT_BASE_MS = 2000;
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

  onEvent(handler: EventHook): () => void {
    this.eventHooks.push(handler);
    void this.socket().catch(() => undefined); // 有订阅即拉起连接
    return () => {
      const i = this.eventHooks.indexOf(handler);
      if (i >= 0) this.eventHooks.splice(i, 1);
    };
  }

  onOpen(handler: OpenHook): () => void {
    this.openHooks.push(handler);
    return () => {
      const i = this.openHooks.indexOf(handler);
      if (i >= 0) this.openHooks.splice(i, 1);
    };
  }

  onClose(handler: CloseHook): () => void {
    this.closeHooks.push(handler);
    return () => {
      const i = this.closeHooks.indexOf(handler);
      if (i >= 0) this.closeHooks.splice(i, 1);
    };
  }

  onAck(handler: AckHook): () => void {
    this.ackHooks.push(handler);
    return () => {
      const i = this.ackHooks.indexOf(handler);
      if (i >= 0) this.ackHooks.splice(i, 1);
    };
  }

  connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private socket(): Promise<WebSocket> {
    const existing = this.ws;
    if (existing && existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (this.connecting) return this.connecting;
    const Ctor = socketFactory ?? WebSocket;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new Ctor(proto + '//' + location.host + '/ws');
    this.ws = ws;
    // 身份守卫（主线同款——2026-09-26 前端流式叠词根因）：被顶替连接的
    // 迟到生命周期回调/帧一律不分发（防双连接双投递）
    const isCurrent = () => this.ws === ws;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => {
        if (!isCurrent()) return;
        this.connecting = null;
        this.reconnectDelay = RECONNECT_BASE_MS;
        const q = this.queue;
        this.queue = [];
        for (const text of q) ws.send(text);
        for (const h of [...this.openHooks]) h();
        resolve(ws);
      };
      ws.onerror = () => {
        if (!isCurrent()) return;
        this.connecting = null;
        reject(new Error('WS 连接失败'));
      };
    });
    ws.onmessage = (ev: MessageEvent) => {
      if (!isCurrent()) return;
      let frame: { type?: unknown; data?: unknown };
      try {
        frame = JSON.parse(String(ev.data)) as { type?: unknown; data?: unknown };
      } catch {
        return; // 非 JSON 帧忽略
      }
      const type = frame.type;
      const data = frame.data;
      if (typeof type !== 'string' || data === null || typeof data !== 'object') return;
      const d = data as Record<string, unknown>;
      if (type === RPC_RESULT && typeof d.requestId === 'string') {
        const p = this.pending.get(d.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(d.requestId);
        if (d.ok === true) p.resolve(d.result);
        else p.reject(new Error(typeof d.error === 'string' ? d.error : 'rpc 失败'));
      } else if (type === WS_ACK && typeof d.requestId === 'string') {
        for (const h of [...this.ackHooks]) h(d as { requestId: string; kind: string; info?: Record<string, unknown> });
      } else {
        // 事件帧：data.args 数组。批帧（llm/delta-batch，cr-85）在此展开——
        // 全部消费者（feed-core 等 onEvent 面）零改动见逐帧序列（主线 wire.ts
        // 同款；cr-586：preview 平移版曾漏此解包，feed-core 只认 llm/delta →
        // 流式 delta 全部静默丢弃）。
        const args = Array.isArray(d.args) ? d.args : [];
        for (const [t, a] of unpackWireFrames(type, args)) {
          for (const h of [...this.eventHooks]) {
            try { h(t, a); } catch { /* 单订阅者异常不殃及 */ }
          }
        }
      }
    };
    ws.onclose = () => {
      if (!isCurrent()) return;
      this.ws = null;
      this.connecting = null;
      for (const h of [...this.closeHooks]) h();
      this.scheduleReconnect();
    };
    return this.connecting;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.socket().catch(() => undefined);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = requestId ?? ('w-' + (++this.seq) + '-' + Date.now().toString(36));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('rpc 超时：' + method));
      }, timeoutMs ?? RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      void this.socket().then((ws) => {
        ws.send(JSON.stringify({ type: RPC_CALL, data: { method, requestId: id, params } }));
      }).catch(reject);
    });
  }

  /** 测试收尾：主动断连（清定时器——不留给 vitest worker 挂住） */
  disposeForTest(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('disposed')); }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }
}

/** 单例（主线 wireRpc 同形） */
export const wireRpcBrowser = new WireRpcClient();
