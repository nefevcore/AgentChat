// ============================================================
// ac-cdp-core/src/client.ts —— CDP ws 客户端
//
// 形态对标 chrome-remote-interface 的成熟面（照抄形状不引依赖，
// browser-cdp-plan §2 非目标）：命令 id 配对（天然可并发——无 FIFO
// 错位问题，旧 daemon 单命令应答制的队列在此退役）、flat session
// 路由（命令带 sessionId 进 target，事件按 sessionId 分发）、
// 单命令超时（超时只拒绝该命令，不重置连接——id 配对下晚到应答
// 自然落空，C4 的 FIFO 对齐重置不再需要）。
// ============================================================
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { CdpEventPayload, CdpWireMessage } from './protocol.ts';

export interface CdpClientOptions {
  /** 建连超时毫秒（缺省 10000） */
  connectTimeoutMs?: number;
  /** 单命令缺省超时毫秒（缺省 30000；send 可逐命令覆盖） */
  commandTimeoutMs?: number;
}

/** CDP 命令级错误（协议 error 回执——code/message/data 原样保留） */
export class CdpCommandError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`CDP ${method} 失败: ${message} (code ${code})`);
    this.name = 'CdpCommandError';
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class CdpClient extends EventEmitter {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private commandTimeoutMs: number;
  private closedByUs = false;
  private dead = false;

  private constructor(ws: WebSocket, commandTimeoutMs: number) {
    super();
    this.ws = ws;
    this.commandTimeoutMs = commandTimeoutMs;
    ws.on('message', (data) => this.onMessage(String(data)));
    // 无 listener 的 'error' 会 uncaught——ws 错误统一由随后的 'close' 收束
    ws.on('error', () => undefined);
    ws.on('close', () => this.onClose());
  }

  /** 建立浏览器级 ws 连接（url = webSocketDebuggerUrl） */
  static async connect(url: string, options: CdpClientOptions = {}): Promise<CdpClient> {
    const timeout = options.connectTimeoutMs ?? 10_000;
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { ws.terminate(); } catch { /* 已亡 */ }
        reject(new Error(`CDP 连接超时（${timeout}ms）: 隐藏 endpoint`));
      }, timeout);
      const onOpen = () => { cleanup(); resolve(); };
      const onFail = (err: unknown) => {
        cleanup();
        try { ws.terminate(); } catch { /* 已亡 */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onFail);
      };
      ws.once('open', onOpen);
      ws.once('error', onFail);
    });
    return new CdpClient(ws, options.commandTimeoutMs ?? 30_000);
  }

  private onMessage(raw: string): void {
    let msg: CdpWireMessage;
    try {
      msg = JSON.parse(raw) as CdpWireMessage;
    } catch {
      return; // 非 JSON 帧（不该出现，静默丢弃不炸连接）
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return; // 已超时落空的晚到应答
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new CdpCommandError(p.method, msg.error.code, msg.error.message, msg.error.data));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      this.emit('event', {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
      } satisfies CdpEventPayload);
    }
  }

  private onClose(): void {
    this.dead = true;
    const err = new Error(this.closedByUs ? 'CDP 连接已关闭' : 'CDP 连接意外断开');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('close');
  }

  get closed(): boolean {
    return this.dead;
  }

  /**
   * 发命令（可并发）。sessionId 指定 flat session 路由到具体 target；
   * 超时只拒绝本命令（不重置连接——id 配对下无错位风险）。
   */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.dead) return Promise.reject(new Error('CDP 连接不可用（已关闭或断线）'));
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.commandTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}（${timeout}ms）`));
      }, timeout);
      timer.unref();
      this.pending.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
        timer,
        method,
      });
      try {
        this.ws.send(JSON.stringify({
          id,
          method,
          params: params ?? {},
          ...(sessionId ? { sessionId } : {}),
        }));
      } catch (err: unknown) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 等待下一个匹配事件（可选超时；返回前解绑监听器，不泄漏） */
  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<CdpEventPayload | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('event', onEvent);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      const onEvent = (ev: CdpEventPayload) => {
        if (ev.method !== method || ev.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.off('event', onEvent);
        resolve(ev);
      };
      this.on('event', onEvent);
    });
  }

  close(): void {
    if (this.closedByUs) return;
    this.closedByUs = true;
    try {
      this.ws.close(1000);
    } catch {
      try { this.ws.terminate(); } catch { /* 已亡 */ }
    }
  }
}
