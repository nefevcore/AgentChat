// ============================================================
// WebUI Server —— HTTP + WebSocket 服务主入口
//
// 职责：
//   1. 启动 Express HTTP 服务器
//   2. 挂载 WebSocket 服务
//   3. 注册 REST API 路由
//   4. 桥接 Router 事件到 WebSocket 前端
// ============================================================

import express from 'express';
import cors from 'cors';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createLogger } from '@agentchat/util';
const logger = createLogger('[server]');
import { configService } from './config-service';
import { WSHandler } from './ws/handler';
import { ServiceRegistry, HistoryService, AgentService, GroupService } from './index';
import { SinglesService } from './singles';
import { RPCBridge } from './rpc';
import { PluginEventBus } from './plugin-events';
import type { HttpRouteRegistry } from './http-routes';

export interface WebUIServerOptions {
  /** 服务注册表（唯一装配入口：agentService/groupService/historyService/pluginManager 等均经此发现） */
  serviceRegistry: ServiceRegistry;
  /** 数据目录路径 */
  dataDir?: string;
  port?: number;
  /** 文件上传目录 */
  uploadDir?: string;
  /** cordis 上下文（全面 cordis 化：门面优先经 ctx 取用；回退 serviceRegistry） */
  ctx?: import('@agentchat/cordis').Context;
  /** 插件域事件总线（bootstrap 注入；WSHandler 订阅后广播给客户端） */
  pluginEvents?: PluginEventBus;
  /** 静态文件目录（前端构建产物） */
  staticDir?: string;
  /** 是否托管前端静态文件（默认：staticDir 存在即托管；不存在则纯 API 降级） */
  serveStatic?: boolean;
  /**
   * HTTP 路由注册表（ctx.http）。WebUIServer 只挂中间件/WS/SPA fallback，
   * 所有 /api/* 与 /ui-plugin 路由由各域插件在 apply 中注册。
   * 缺省为空 Router（纯 API 降级，不挂任何业务路由）。
   */
  routeRegistry?: HttpRouteRegistry;
}

export class WebUIServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private wsHandler: WSHandler;
  private options: Required<Omit<WebUIServerOptions, 'serviceRegistry'>>;
  private historyService: HistoryService;
  private agentService?: AgentService;
  private groupService?: GroupService;
  /** 正在进行的启动（二次 start 复用同一 Promise） */
  private startPromise?: Promise<number>;
  /** 已监听端口（已启动后二次 start 直接返回该端口） */
  private boundPort?: number;

  constructor(options: WebUIServerOptions) {
    // src/host/server → 仓库根；前端产物在 src/ui/webui/dist。
    // 用 import.meta.url 推导仓库根，避免依赖 process.cwd()。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoStaticDir = path.resolve(here, '../../..', 'ui', 'webui', 'dist');
    const cwdStaticDir = path.resolve(process.cwd(), 'src', 'ui', 'webui', 'dist');
    const staticDir = options.staticDir
      ?? (fs.existsSync(repoStaticDir) ? repoStaticDir : cwdStaticDir);
    // 默认行为：前端构建产物存在即托管（dev/prod 一视同仁，桌面端/单进程场景后端自包含）；不存在则纯 API 降级
    const serveStatic = options.serveStatic ?? fs.existsSync(staticDir);

    this.options = {
      port: options.port ?? 3830,
      uploadDir: options.uploadDir ?? path.join(configService.getGlobalConfig().workspaceDir, 'files'),
      staticDir,
      dataDir: options.dataDir ?? configService.getGlobalConfig().workspaceDir,
      serveStatic,
    } as Required<Omit<WebUIServerOptions, 'serviceRegistry'>>;

    // ---- L4 服务发现：全部经 ServiceRegistry（唯一装配入口，无直接传参） ----
    // 服务在 L5 bootstrap 注册；server 只 import services 类型 + 注册表，解耦装配。
    // ctx 服务用可选能力读取（ctx.get），未提供时回退 registry，不触发 inject 硬依赖。
    const reg = options.serviceRegistry;
    const ctxHistory = options.ctx?.get?.('historyService') as { service: HistoryService } | undefined;
    const ctxAgent = options.ctx?.get?.('agentService') as { service: AgentService } | undefined;
    const ctxGroup = options.ctx?.get?.('groupService') as { service: GroupService } | undefined;
    this.historyService = ctxHistory?.service ?? reg.require<HistoryService>('historyService');
    this.agentService = ctxAgent?.service ?? reg.get<AgentService>('agentService');
    this.groupService = ctxGroup?.service ?? reg.get<GroupService>('groupService');

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // 配置中间件
    this.app.use(cors());
    this.app.use(express.json());

    // 静态文件（前端构建产物）—— dist 存在即托管（桌面端/单进程场景后端自包含）
    if (this.options.serveStatic) {
      this.app.use(express.static(this.options.staticDir));
    }

    // 注册 API 路由：全部经 ctx.http 路由注册表（L3 传输层插件化）。
    // 缺省空 Router 保持纯 API 降级（直接构造 WebUIServer 的旧调用不会崩，
    // 但业务路由需由各域插件行注册）。
    this.app.use(options.routeRegistry?.middleware ?? express.Router());

    // WebSocket 处理（Router/Registry/GroupManager 经 services/runtime 门面获取）
    this.wsHandler = new WSHandler({
      messageQuery: this.historyService,
      historyService: this.historyService, // 归档/压缩等历史服务操作（v0.5.0 审查修复）
      dataDir: this.options.dataDir,
      rpc: this.buildRPC(reg),
      agentService: this.agentService,
      groupService: this.groupService,
      singlesService: options.ctx?.get?.('l4')?.singlesService ?? reg.get<SinglesService>('singlesService') ?? undefined,
      pluginEvents: options.pluginEvents,
    });

    this.wss.on('connection', (ws, req) => {
      this.wsHandler.handleConnection(ws as any, req);
    });

    // SPA fallback - catch all non-API routes（托管模式下生效）
    if (this.options.serveStatic) {
      this.app.use((_req, res, next) => {
        // Skip API routes
        if (_req.path.startsWith('/api/')) {
          return next();
        }
        const indexPath = path.join(this.options.staticDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res.status(200).json({ message: 'AgentChat WebUI API Server — frontend not built.' });
        }
      });
    }
  }

  /**
   * 启动服务器
   */
  /**
   * 构建 RPC 桥（v0.5.0 P5）：从 ServiceRegistry 注册的服务映射 RPC 方法。
   * 服务通过 registerService(name, svc) 自动注册其公开方法为 "name.method"。
   */
  private buildRPC(reg: ServiceRegistry): RPCBridge | undefined {
    const rpc = new RPCBridge(reg);
    // 注册已注册的服务（agentService/groupService/historyService）
    const agentService = reg.get('agentService');
    if (agentService) rpc.registerService('agent', agentService as object);
    const groupService = reg.get('groupService');
    if (groupService) rpc.registerService('group', groupService as object);
    const historyService = reg.get('historyService');
    if (historyService) rpc.registerService('history', historyService as object);
    return rpc;
  }
  /**
   * 启动服务器。
   * 幂等语义：已监听 → 直接返回已绑定端口；启动中 → 复用同一 Promise；
   * 不会因二次调用重复 listen（listen 报 EADDRINUSE 会 reject 给等待方）。
   */
  start(): Promise<number> {
    if (this.server.listening && this.boundPort != null) {
      return Promise.resolve(this.boundPort);
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.options.port, '::', () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        const port = typeof addr === 'object' ? addr?.port : this.options.port;
        this.boundPort = port ?? this.options.port;
        logger.info(`\n[WebUI] 服务器已启动：http://localhost:${this.boundPort}`);
        logger.info(`[WebUI] WebSocket 就绪：ws://localhost:${this.boundPort}`);
        resolve(this.boundPort);
      });
    }).finally(() => {
      this.startPromise = undefined;
    });

    return this.startPromise;
  }

  /**
   * 停止服务器
   * 主动断开 WS 连接 + 超时兜底（活跃连接会让 server.close 永久挂起）
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 0. 停止 WS 心跳定时器
      this.wsHandler.stop();

      // 1. 主动断开所有 WebSocket 连接（否则 server.close 等活跃连接永不回调）
      try {
        for (const client of this.wss.clients) {
          client.close(1001, 'server shutting down');
        }
      } catch { /* ignore */ }

      // 2. 关闭 WS + HTTP server，带超时兜底
      const timer = setTimeout(() => {
        logger.warn('[WebUI] stop() 超时（2s），强制返回');
        resolve();
      }, 2000);

      this.wss.close();
      this.server.close((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else {
          this.boundPort = undefined;
          resolve();
        }
      });
    });
  }
}
