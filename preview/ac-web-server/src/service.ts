// ============================================================
// ac-web-server/src/service.ts —— Web 传输服务（ctx.webServer）
//
// src WebUIServer + HttpRouteRegistry + WSHandler 传输半边的 preview
// 形态（地图 §3.3 / ADR-6：宿主中间层删除——本服务不 import 任何业务
// 服务，业务面由各域行注册）：
//   · HTTP：路由注册中心（method+pattern 注册、`:param`/尾 `*` 捕获、
//     注册即归属 fiber.effect、同 method+pattern 重注册抛错）
//   · 静态：staticDir 可选（安全路径解析 + SPA fallback）
//   · WS：广播/定向帧、30s 心跳（2 拍无 pong terminate）、
//     rpc/call 显式分发表、requestId 幂等去重（deduped ack——src
//     #53/#91 重连 flush 重复持久化事故的教训原样继承，窗口 30s）
//   · ack：deduped（传输层内置判定）+ busy/parked（投递方经 ack() 上报）
// ============================================================
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Service, type Context } from '@agentchat/cordis';
import {
  buildFrame,
  parseFrame,
  parseRpcCall,
  RPC_CALL,
  RPC_RESULT,
  WS_ACK,
  WS_READY,
  type WsAckKind,
  type WsAckPayload,
} from 'ac-ws-protocol';
import type {
  ConnectionInfo,
  HttpMethod,
  RouteCall,
  RouteHandler,
  RpcHandler,
} from './contract.ts';

export interface WebServerRowOptions {
  /** 监听端口（缺省 3830；0 = 随机，测试用） */
  port?: number;
  /** 监听地址（缺省 '::'） */
  host?: string;
  /** 静态文件目录（前端构建产物；存在即托管 + SPA fallback，缺省不托管） */
  staticDir?: string;
  /** requestId 幂等去重窗口 ms（缺省 30000；0 = 关闭） */
  dedupMs?: number;
  /** WS 心跳间隔 ms（缺省 30000；0 = 关闭） */
  heartbeatMs?: number;
  /** JSON 请求体上限字节（缺省 10 MiB） */
  maxBodyBytes?: number;
}

interface CompiledRoute {
  method: HttpMethod;
  pattern: string;
  /** 静态段（'/' 分割；':x' 为参数段；尾部 '*' 捕获剩余路径） */
  segments: string[];
  handler: RouteHandler;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export class WebServerService extends Service {
  private readonly options: Required<Pick<WebServerRowOptions, 'port' | 'host' | 'dedupMs' | 'heartbeatMs' | 'maxBodyBytes'>>;
  private readonly staticDir: string | undefined;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly routes: CompiledRoute[] = [];
  private readonly rpcTable = new Map<string, RpcHandler>();
  private readonly connections = new Map<string, { ws: WebSocket; info: ConnectionInfo; alive: boolean }>();
  /** requestId 幂等缓存：`${method}|${requestId}` → 最近处理时刻 */
  private readonly recentCalls = new Map<string, number>();
  private connSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listening: Promise<number>;
  /** 监听失败原因（降级标志：传输面未就绪但服务 API 可用） */
  listenError?: Error;
  private stopped = false;

  constructor(ctx: Context, options: WebServerRowOptions = {}) {
    super(ctx, 'webServer');
    this.options = {
      port: options.port ?? 3830,
      host: options.host ?? '::',
      dedupMs: options.dedupMs ?? 30_000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      maxBodyBytes: options.maxBodyBytes ?? 10 * 1024 * 1024,
    };
    this.staticDir = options.staticDir;

    this.server = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    // ws 库把 http server 的 'error' 转发给 wss.emit('error')——EventEmitter
    // 无 listener 的 'error' 会直接 throw（uncaught）。常驻 sink 接住：
    // 监听失败（EADDRINUSE 等）在这里降级为日志，不炸进程
    this.wss.on('error', (err) => {
      if (!this.listenError) this.listenError = err;
      this.ctx.logger.warn(`[webServer] 传输层错误（降级继续）: ${err.message}`);
    });

    this.listening = new Promise<number>((resolve) => {
      const onListenError = (err: Error) => {
        this.listenError = err;
        this.ctx.logger.warn(
          `[webServer] 监听失败（${err.message}）——传输面降级：路由/RPC 注册继续可用，但无外部访问口`,
        );
        resolve(this.options.port); // 降级 resolve（不 reject：无人 await 时不产生 unhandled）
      };
      const onListening = () => {
        this.server.off('error', onListenError);
        const addr = this.server.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.options.port;
        // M18 调试可见性：启动即打印实际监听口（port=0 随机口时尤其重要）
        this.ctx.logger.info(
          `[webServer] 已监听 http://%C:%C（WS/HTTP/RPC 同口；静态目录 %C）`,
          this.options.host,
          String(port),
          this.staticDir ?? '(无)',
        );
        resolve(port);
      };
      this.server.once('error', onListenError);
      this.server.listen(this.options.port, this.options.host, onListening);
    });

    this.startHeartbeat();

    // 注册即归属：行摘除/进程收尾 → 停 server 断连接（dispose 兜底，可显式 stop）；
    // 清理返回 Promise——fiber dispose 等待端口真正释放（连续 boot 不撞口）
    this.ctx.fiber.effect(
      () => () => this.stop(),
      'webServer.stop',
    );
  }

  /** 实际监听端口（port 0 时测试需要）；监听失败时返回配置端口（listenError 置位） */
  async ready(): Promise<number> {
    return this.listening;
  }

  get boundPort(): number | undefined {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : undefined;
  }

  // ============================================================
  // HTTP 路由注册中心
  // ============================================================

  /**
   * 注册 HTTP 路由。pattern 支持 `:name` 参数段与尾 `*` 通配
   * （如 `/ui-plugin/*`）；同 method+pattern 重复注册抛错。
   * @returns disposer（随注册方 fiber 卸载自动执行）
   */
  route(method: HttpMethod, pattern: string, handler: RouteHandler) {
    if (!pattern.startsWith('/')) throw new Error(`路由 pattern 须以 / 开头: ${pattern}`);
    if (this.routes.some((r) => r.method === method && r.pattern === pattern)) {
      throw new Error(`路由 "${method} ${pattern}" 已注册`);
    }
    const segments = pattern.slice(1).split('/');
    return this.ctx.fiber.effect(() => {
      this.routes.push({ method, pattern, segments, handler });
      return () => {
        const idx = this.routes.findIndex((r) => r.method === method && r.pattern === pattern);
        if (idx >= 0) this.routes.splice(idx, 1);
      };
    }, `webServer.route(${method} ${pattern})`);
  }

  private matchRoute(method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | undefined {
    const parts = path.slice(1).split('/');
    let fallback: { route: CompiledRoute; params: Record<string, string> } | undefined;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      let ok = true;
      const dynamic = route.segments[route.segments.length - 1] === '*';
      if (!dynamic && route.segments.length !== parts.length) continue;
      if (dynamic && parts.length < route.segments.length - 1) continue;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg === '*') {
          params['*'] = parts.slice(i).join('/');
          break;
        }
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
          continue;
        }
        if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const hit = { route, params };
      if (!dynamic) return hit; // 精确匹配优先于通配
      fallback ??= hit;
    }
    return fallback;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const hit = this.matchRoute(req.method ?? 'GET', path);
      if (hit) {
        const body = await this.readBody(req, res);
        if (res.writableEnded) return; // 读体失败已应答
        const call: RouteCall = {
          method: (req.method as HttpMethod) ?? 'GET',
          path,
          query: url.searchParams,
          params: hit.params,
          body,
          req,
          res,
        };
        await hit.route.handler(call);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && this.staticDir) {
        await this.serveStatic(path, res, req.method === 'HEAD');
        return;
      }
      this.replyJson(res, 404, { error: `no route: ${req.method} ${path}` });
    } catch (err) {
      this.ctx.logger.warn(`[webServer] 请求处理异常 ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.writableEnded) this.replyJson(res, 500, { error: 'internal error' });
    }
  }

  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const type = req.headers['content-type'] ?? '';
    if (type.includes('multipart/form-data')) {
      return this.readMultipart(req, res, type);
    }
    if (!type.includes('application/json')) return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.options.maxBodyBytes) {
        this.replyJson(res, 413, { error: 'body too large' });
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      this.replyJson(res, 400, { error: 'invalid JSON body' });
      return undefined;
    }
  }

  /**
   * multipart/form-data 解析（M17-E 上传面；最小实现：boundary 分割 +
   * Content-Disposition name/filename）。字段 → fields，文件 → files
   * （Buffer 二进制安全）。解析失败返回 undefined（413/400 已应答）。
   */
  private async readMultipart(
    req: IncomingMessage,
    res: ServerResponse,
    contentType: string,
  ): Promise<unknown> {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    const boundary = match?.[1] ?? match?.[2];
    if (!boundary) {
      this.replyJson(res, 400, { error: 'multipart boundary 缺失' });
      return undefined;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.options.maxBodyBytes) {
        this.replyJson(res, 413, { error: 'body too large' });
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks);
    const parts = this.splitMultipart(raw, `--${boundary}`);
    const fields: Record<string, string> = {};
    const files: Record<string, { filename: string; contentType: string; data: Buffer }> = {};
    for (const part of parts) {
      const sep = part.indexOf('\r\n\r\n');
      const headerText = sep >= 0 ? part.subarray(0, sep).toString('utf-8') : '';
      let body = sep >= 0 ? part.subarray(sep + 4) : Buffer.alloc(0);
      // 去尾部 \r\n（boundary 后内容以 CRLF 收尾）
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      }
      const nameMatch = /name="([^"]*)"/.exec(headerText);
      const name = nameMatch?.[1];
      if (!name) continue;
      const fileMatch = /filename="([^"]*)"/.exec(headerText);
      if (fileMatch) {
        const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
        files[name] = {
          filename: fileMatch[1],
          contentType: ctMatch?.[1]?.trim() ?? 'application/octet-stream',
          data: body,
        };
      } else {
        fields[name] = body.toString('utf-8');
      }
    }
    return { fields, files };
  }

  /** 按 boundary 分割（首尾哨兵段丢弃；边界前后各带 CRLF） */
  private splitMultipart(raw: Buffer, boundary: string): Buffer[] {
    const parts: Buffer[] = [];
    let cursor = 0;
    for (;;) {
      const idx = raw.indexOf(boundary, cursor);
      if (idx < 0) break;
      if (idx > cursor) parts.push(raw.subarray(cursor, idx));
      // 越过 boundary 行（boundary + CRLF；"--" 结尾 = 终止）
      let end = idx + boundary.length;
      if (raw[end] === 0x2d && raw[end + 1] === 0x2d) return parts; // '--'
      if (raw[end] === 0x0d && raw[end + 1] === 0x0a) end += 2;
      cursor = end;
    }
    return parts;
  }

  private async serveStatic(path: string, res: ServerResponse, head = false): Promise<void> {
    const root = resolve(this.staticDir!);
    const rel = decodeURIComponent(path).replace(/^\/+/, '');
    let full = normalize(join(root, rel));
    if (!full.startsWith(root)) {
      this.replyJson(res, 403, { error: 'forbidden' });
      return;
    }
    // 缓存策略（2026-08-30 事故：无任何缓存头 → 浏览器启发式缓存旧
    // index.html → dist 重建后浏览器永远跑旧 bundle，前端修复"不生效"）：
    //   · assets/* = 构建产物内容哈希文件名（vite）→ immutable 长缓存
    //   · 其余（index.html / SPA fallback / 杂项静态）= no-cache 每次回源
    const cacheControl = rel.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    try {
      const s = await stat(full);
      if (s.isDirectory()) full = join(full, 'index.html');
      const data = await readFile(full);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(full)] ?? 'application/octet-stream',
        'cache-control': cacheControl,
        'content-length': data.length,
      });
      res.end(head ? undefined : data);
    } catch {
      // SPA fallback：非文件路径回 index.html（前端路由）
      try {
        const index = await readFile(join(root, 'index.html'));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': index.length,
        });
        res.end(head ? undefined : index);
      } catch {
        this.replyJson(res, 404, { error: 'not found' });
      }
    }
  }

  replyJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  // ============================================================
  // WS 连接管理与 RPC 分发
  // ============================================================

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = `c${++this.connSeq}`;
    this.connections.set(connId, { ws, info: { connId, connectedAt: Date.now(), remoteAddress: req.socket.remoteAddress }, alive: true });
    ws.on('pong', () => {
      const entry = this.connections.get(connId);
      if (entry) entry.alive = true;
    });
    ws.on('message', (data) => this.handleMessage(connId, data.toString()));
    ws.on('close', (code, reason) => {
      this.connections.delete(connId);
      this.ctx.emit('ws/connection-closed', connId, code, reason.toString());
    });
    ws.send(buildFrame(WS_READY, { protocol: 1, connId, serverStartedAt: Date.now() }));
    this.ctx.emit('ws/connection-opened', connId);
  }

  private handleMessage(connId: string, raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return; // 非 JSON / 缺 type：静默丢弃
    const entry = this.connections.get(connId);
    if (!entry) return;

    if (frame.type === RPC_CALL) {
      void this.handleRpc(connId, entry.ws, frame);
    }
    // 其余入站类型忽略（业务帧是出站语义；入站统一走 rpc/call 显式注册）
  }

  private async handleRpc(connId: string, ws: WebSocket, frame: { type: string; data?: unknown }): Promise<void> {
    const call = parseRpcCall(frame as { type: string; data?: unknown });
    if (!call) {
      ws.send(buildFrame(RPC_RESULT, { ok: false, error: 'malformed rpc/call frame' }));
      return;
    }
    // 幂等去重：同 method+requestId 短窗重发 → deduped ack，不重复执行
    const key = `${call.method}|${call.requestId}`;
    if (this.options.dedupMs > 0) {
      const now = Date.now();
      const seen = this.recentCalls.get(key);
      if (seen !== undefined && now - seen < this.options.dedupMs) {
        this.dispatchAck(ws, { requestId: call.requestId, kind: 'deduped' });
        return;
      }
      this.recentCalls.set(key, now);
      if (this.recentCalls.size > 1000) this.evictStaleCalls(now);
    }
    const handler = this.rpcTable.get(call.method);
    if (!handler) {
      ws.send(buildFrame(RPC_RESULT, { requestId: call.requestId, ok: false, error: `unknown method: ${call.method}` }));
      return;
    }
    const caller = {
      requestId: call.requestId,
      connId,
      ack: (kind: WsAckKind, info?: Record<string, unknown>) => this.ack(call.requestId, kind, info, connId),
    };
    try {
      const result = await handler(call.params, caller);
      ws.send(buildFrame(RPC_RESULT, { requestId: call.requestId, ok: true, result }));
    } catch (err) {
      ws.send(buildFrame(RPC_RESULT, {
        requestId: call.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private evictStaleCalls(now: number): void {
    for (const [k, t] of this.recentCalls) {
      if (now - t >= this.options.dedupMs) this.recentCalls.delete(k);
    }
  }

  /** 显式注册 RPC 方法（WS 入站 rpc/call 的分发目标；重名抛错） */
  registerRpc(method: string, handler: RpcHandler) {
    if (this.rpcTable.has(method)) throw new Error(`rpc "${method}" 已注册`);
    return this.ctx.fiber.effect(() => {
      this.rpcTable.set(method, handler);
      return () => {
        this.rpcTable.delete(method);
      };
    }, `webServer.rpc(${method})`);
  }

  /** 已注册 RPC 方法清单（诊断/自描述） */
  rpcMethods(): string[] {
    return [...this.rpcTable.keys()];
  }

  /**
   * 投递回执：向来源连接（缺省广播）发 ws/ack 帧 + emit ws/ack 事件。
   * deduped 由传输层内置判定；busy/parked 由投递方按 conversation
   * outcome（steered/queued/timeout）上报。
   */
  ack(requestId: string, kind: WsAckKind, info?: Record<string, unknown>, connId?: string): void {
    const payload: WsAckPayload = { requestId, kind, ...(info ? { info } : {}) };
    if (connId) {
      const entry = this.connections.get(connId);
      if (entry) entry.ws.send(buildFrame(WS_ACK, payload));
    } else {
      this.broadcast(WS_ACK, payload);
    }
    this.ctx.emit('ws/ack', payload);
  }

  private dispatchAck(ws: WebSocket, payload: WsAckPayload): void {
    ws.send(buildFrame(WS_ACK, payload));
    this.ctx.emit('ws/ack', payload);
  }

  /** 广播业务帧（type = 事件名直转；无连接时静默） */
  broadcast(type: string, data?: unknown): void {
    const raw = buildFrame(type, data);
    for (const { ws } of this.connections.values()) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  /** 定向帧（返回是否送达） */
  send(connId: string, type: string, data?: unknown): boolean {
    const entry = this.connections.get(connId);
    if (!entry || entry.ws.readyState !== entry.ws.OPEN) return false;
    entry.ws.send(buildFrame(type, data));
    return true;
  }

  /** 当前连接清单（诊断） */
  listConnections(): ConnectionInfo[] {
    return [...this.connections.values()].map((e) => ({ ...e.info }));
  }

  /** 心跳：周期 ping；连续 2 拍无 pong → terminate（清半死连接） */
  private startHeartbeat(): void {
    if (this.options.heartbeatMs <= 0 || this.heartbeatTimer) return;
    let misses = new Map<string, number>();
    this.heartbeatTimer = setInterval(() => {
      for (const [connId, entry] of this.connections) {
        if (entry.alive) {
          entry.alive = false;
          misses.delete(connId);
          entry.ws.ping();
        } else {
          const count = (misses.get(connId) ?? 0) + 1;
          if (count >= 2) {
            misses.delete(connId);
            entry.ws.terminate();
          } else {
            misses.set(connId, count);
          }
        }
      }
    }, this.options.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /** 停服：断开 WS + 关 HTTP（2s 超时兜底——活跃连接会挂起 close 回调） */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const { ws } of this.connections.values()) {
      try {
        ws.close(1001, 'server shutting down');
      } catch { /* ignore */ }
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      timer.unref?.();
      this.wss.close(() => {
        this.server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    });
  }
}

// 注：心跳在构造尾启动（interval unref——不阻 preview:boot 自退）

declare module '@agentchat/cordis' {
  interface Context {
    /** Web 传输服务（ac-web-server 提供）：HTTP 路由注册中心 + WS 广播/RPC/ack */
    webServer: WebServerService;
  }
}
