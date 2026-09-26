
import { WebSocketServer, type WebSocket } from 'ws';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** 最小 fake CDP 测试服务器：/json/version + ws 命令应答（可编程） */
export class FakeCdpServer {
  readonly server: http.Server;
  readonly wss: WebSocketServer;
  ws: WebSocket | null = null;
  port = 0;
  /** method → 应答 result 或实现（可编程；未编程的命令回空对象） */
  handlers = new Map<string, (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>>();
  /** 收到的命令序列（断言用） */
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ Browser: 'fake-cdp/1', webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/abc` }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      this.ws = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id === undefined) return;
        this.calls.push({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
        const h = this.handlers.get(msg.method);
        let outcome: Promise<Record<string, unknown>>;
        try {
          outcome = Promise.resolve(h ? h(msg.params ?? {}) : {});
        } catch (err) {
          outcome = Promise.reject(err);
        }
        outcome.then(
          (result) => ws.send(JSON.stringify({ id: msg.id, result })),
          (err) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: String(err instanceof Error ? err.message : err) } })),
        );
      });
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  url(): string {
    return `ws://127.0.0.1:${this.port}/devtools/browser/abc`;
  }

  /** 注入事件帧（flat session 形） */
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.ws?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const c of this.wss.clients) c.terminate();
      this.server.close(() => resolve());
    });
  }
}
