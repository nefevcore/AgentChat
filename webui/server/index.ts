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
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { AgentRouter } from '@routing/router';
import { AgentRegistry } from '@routing/registry';
import { IMessageQuery } from '@routing/message-query';
import { RoomManager } from '@routing/room-manager';
import { AgentLoader } from '@discovery/agent-loader';
import { logger } from '@utils/logger';
import { getGlobalConfig } from '@core/config';
import { createAgentsRouter } from './api/agents';
import { createHistoryRouter } from './api/history';
import { createUploadRouter } from './api/upload';
import { createPluginsRouter } from './api/plugins';
import { createConfigRouter } from './api/config';
import { createRoomsRouter } from './api/rooms';
import { createBrowseRouter } from './api/browse';
import { createWorkspaceRouter } from './api/workspace';
import { createUsageRouter } from './api/usage';
import { WSHandler } from './ws/handler';

export interface WebUIServerOptions {
  router: AgentRouter;
  registry: AgentRegistry;
  messageQuery: IMessageQuery;
  /** RoomManager 实例（群聊功能） */
  roomManager?: RoomManager;
  /** AgentLoader 实例，用于插件查询与管理 */
  loader?: AgentLoader;
  /** 数据目录路径 */
  dataDir?: string;
  port?: number;
  /** 文件上传目录 */
  uploadDir?: string;
  /** 静态文件目录（前端构建产物） */
  staticDir?: string;
  /** 是否托管前端静态文件（生产模式默认 true，开发模式默认 false） */
  serveStatic?: boolean;
}

export class WebUIServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private wsHandler: WSHandler;
  private options: Required<WebUIServerOptions>;

  constructor(options: WebUIServerOptions) {
    const serveStatic = options.serveStatic ?? (process.env.NODE_ENV === 'production');

    this.options = {
      port: options.port ?? 3830,
      uploadDir: options.uploadDir ?? path.join(getGlobalConfig().workspaceDir, 'files'),
      staticDir: options.staticDir ?? path.resolve(__dirname, '..', 'client', 'dist'),
      dataDir: options.dataDir ?? getGlobalConfig().workspaceDir,
      router: options.router,
      registry: options.registry,
      messageQuery: options.messageQuery,
      loader: options.loader,
      roomManager: options.roomManager,
      serveStatic,
    } as Required<WebUIServerOptions>;

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // 配置中间件
    this.app.use(cors());
    this.app.use(express.json());

    // 静态文件（前端构建产物）—— 仅在非开发模式下托管
    if (this.options.serveStatic) {
      this.app.use(express.static(this.options.staticDir));
    }

    // 注册 API 路由
    this.app.use('/api/agents', createAgentsRouter(this.options.registry, this.options.loader, this.options.router));
    this.app.use('/api/history', createHistoryRouter(this.options.messageQuery));
    this.app.use('/api/upload', createUploadRouter(this.options.uploadDir));
    this.app.use('/api/config', createConfigRouter());

    // 插件管理路由（需要 AgentLoader）
    if (this.options.loader) {
      this.app.use('/api/plugins', createPluginsRouter(this.options.loader));
    }

    // 文件浏览路由（打开原生文件选择对话框）
    this.app.use('/api/browse', createBrowseRouter());

    // 工作区文件预览路由
    this.app.use('/api/workspace', createWorkspaceRouter());

    // Token 用量路由
    this.app.use('/api/usage', createUsageRouter());

    // 群聊房间路由（需要 RoomManager）
    if (this.options.roomManager) {
      this.app.use('/api/rooms', createRoomsRouter(this.options.roomManager));
    }

    // WebSocket 处理
    this.wsHandler = new WSHandler({
      router: this.options.router,
      registry: this.options.registry,
      messageQuery: this.options.messageQuery,
      roomManager: this.options.roomManager,
    });

    this.wss.on('connection', (ws, req) => {
      this.wsHandler.handleConnection(ws as any, req);
    });

    // SPA fallback - catch all non-API routes（仅在生产模式）
    if (this.options.serveStatic) {
      this.app.use((_req, res, next) => {
        // Skip API routes
        if (_req.path.startsWith('/api/')) {
          return next();
        }
        const indexPath = path.join(this.options.staticDir, 'index.html');
        if (require('fs').existsSync(indexPath)) {
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
  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, () => {
        const addr = this.server.address();
        const port = typeof addr === 'object' ? addr?.port : this.options.port;
        logger.info(`\n[WebUI] 服务器已启动：http://localhost:${port}`);
        logger.info(`[WebUI] WebSocket 就绪：ws://localhost:${port}`);
        resolve(port ?? this.options.port);
      });
    });
  }

  /**
   * 停止服务器
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close();
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
