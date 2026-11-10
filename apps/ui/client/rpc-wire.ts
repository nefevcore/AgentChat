// ============================================================
// rpc-wire.ts —— 浏览器 rpcWire 真面（8.5e）
//
// 主线 webui/src/api/wire.ts 的 preview 平移（wireRpc 单例语义——
// rpc-host.ts RpcWire 注入面的浏览器实现）：
//   · 单 WS 通道 /ws：rpc/call + requestId 相关性 + 超时；
//   · 事件帧解包直转（批帧 llm/delta-batch 展开为逐帧 llm/delta——
//     feed-core 消费面，主线 wire.ts 同款）；
//   · 断线重连（退避 2s→30s + healthz 探测快路，onOpen 通知）；
//   · 换代检测（cr-948）：WS_READY epoch 变化 = 宿主已重启 → 广播
//     ws/epoch-restart（域层全量 resync——feed/名册/wire/子面板）；
//   · 身份守卫（isCurrent——被顶替连接的迟到回调一律忽略）。
// 主线终态 = apps/ui/src/api/wire.ts 整体平移进 ac-webui 单包
// client/ 半边（cutover 收编本文件——ui-tree §4）。
// ============================================================
import { unpackWireFrames } from 'ac-wire-format';
import { traceSwitch } from 'ac-client-runtime';
import { hostUrl } from './host-endpoint.ts';
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
// 换代重启的快路重连间隔（cr-948）：宿主 restart_host 窗口通常 <5s，
// 退避爬到 30s 对它是钝刀；healthz 探测到宿主在听即提前重连。
const PROBE_MS = 500;
const WS_READY = 'ws/ready';

type EventHook = (type: string, args: unknown[]) => void;
type OpenHook = () => void;
type CloseHook = () => void;
type AckHook = (payload: { requestId: string; kind: string; info?: Record<string, unknown> }) => void;
// 换代重启钩子（cr-948）：epoch 变化的重连触发——区别于普通 onOpen。
type EpochHook = () => void;

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
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private lastEpoch: string | null = null;
  private eventHooks: EventHook[] = [];
  private openHooks: OpenHook[] = [];
  private closeHooks: CloseHook[] = [];
  private ackHooks: AckHook[] = [];
  private epochHooks: EpochHook[] = [];

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

  onEpoch(handler: EpochHook): () => void {
    this.epochHooks.push(handler);
    return () => {
      const i = this.epochHooks.indexOf(handler);
      if (i >= 0) this.epochHooks.splice(i, 1);
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
    // 独立部署形态（cr-917）：宿主端点非同源时 WS 指向宿主 origin
    //（hostUrl 同源返回相对路径——现状 URL 逐字节等价）；协议随宿主 origin
    const target = new URL(hostUrl('/ws'), location.href);
    const wsUrl = (target.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + target.host + target.pathname;
    const ws = new Ctor(wsUrl);
    this.ws = ws;
    // 身份守卫（主线同款——2026-09-26 前端流式叠词根因）：被顶替连接的
    // 迟到生命周期回调/帧一律不分发（防双连接双投递）
    const isCurrent = () => this.ws === ws;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => {
        if (!isCurrent()) return;
        this.connecting = null;
        this.stopProbe();
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
      // WS_READY（cr-948）：epoch 变化 = 宿主换代重启（restart_host 等）——
      // 断连窗口的事件帧全部不可追，各域须全量对账。首连（lastEpoch 为空）
      // 只记录基线，不触发——冷启动各域本就走首拉。
      if (type === WS_READY && typeof d.epoch === 'string') {
        const prev = this.lastEpoch;
        this.lastEpoch = d.epoch;
        if (prev !== null && prev !== d.epoch) {
          for (const h of [...this.epochHooks]) {
            try { h(); } catch { /* 单订阅者异常不殃及 */ }
          }
        }
      }
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
    if (this.reconnectTimer !== null) { this.startProbe(); return; }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.socket().catch(() => undefined);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.startProbe();
  }

  /** healthz 探测快路（cr-948）：宿主 restart_host 窗口内退避序列会爬到
   *  数十秒——每 PROBE_MS 探一次传输基座端点，通了即立刻重连（restart
   *  后首连常撞 boot 早期窗口，onOpen 恢复钩子的退避重试兜住）。 */
  private startProbe(): void {
    if (this.probeTimer !== null) return;
    this.probeTimer = setInterval(() => {
      void fetch(new URL(hostUrl('/healthz'), location.href), { method: 'HEAD' })
        .then((res) => {
          if (res.ok) this.connectNow();
        })
        .catch(() => undefined);
    }, PROBE_MS);
  }

  private stopProbe(): void {
    if (this.probeTimer !== null) { clearInterval(this.probeTimer); this.probeTimer = null; }
  }

  private connectNow(): void {
    this.stopProbe();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectDelay = RECONNECT_BASE_MS;
    void this.socket().catch(() => undefined);
  }

  call<T>(method: string, params?: unknown, requestId?: string, timeoutMs?: number): Promise<T> {
    const t0 = Date.now();
    return new Promise<T>((resolve, reject) => {
      const id = requestId ?? ('w-' + (++this.seq) + '-' + Date.now().toString(36));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('rpc 超时：' + method));
      }, timeoutMs ?? RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v: unknown) => { if (Date.now() - t0 > 1000) traceSwitch('rpc-slow', `${method} ${Date.now() - t0}ms`); resolve(v as T); },
        reject: (e: Error) => { if (Date.now() - t0 > 1000) traceSwitch('rpc-slow', `${method} 失败 ${Date.now() - t0}ms`); reject(e); },
        timer,
      });
      void this.socket().then((ws) => {
        ws.send(JSON.stringify({ type: RPC_CALL, data: { method, requestId: id, params } }));
      }).catch(reject);
    });
  }

  /** 测试收尾：主动断连（清定时器——不留给 vitest worker 挂住） */
  disposeForTest(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopProbe();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('disposed')); }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }
}

/** 单例（主线 wireRpc 同形） */
export const wireRpcBrowser = new WireRpcClient();
