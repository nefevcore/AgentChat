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
import { AgentRouter } from '@agents/router';
import { AgentRegistry } from '@agents/registry';
import { GroupManager } from '@agents/group';
import { logger } from '@utils/logger';
import { AgentService } from '@services/agent-service';
import { configService } from '@services/config-service';
import type { GroupService } from '@services/group-service';
import { createAgentsRouter } from './api/agents';
import { createHistoryRouter } from './api/history';
import { createUploadRouter } from './api/upload';
import { createPluginsRouter, PluginManager } from './api/plugins';
import { createConfigRouter } from './api/config';
import { createGroupsRouter } from './api/groups';
import { createBrowseRouter } from './api/browse';
import { createWorkspaceRouter } from './api/workspace';
import { createBackupRouter } from './api/backup';
import { createVersionRouter } from './api/version';
import { createUsageRouter } from './api/usage';
import { createSessionRouter } from './api/sessions';
import { WSHandler } from './ws/handler';
import { ServiceRegistry, HistoryService } from '@services/index';
import { RPCBridge } from '@services/rpc';

export interface WebUIServerOptions {
  router: AgentRouter;
  registry: AgentRegistry;
  /** 历史消息服务（v0.5.0: 替代直接穿透 IMessageQuery） */
  historyService: HistoryService;
  /** GroupManager 实例（群组功能） */
  GroupManager?: GroupManager;
  /** 服务注册表（v0.5.0 P3/P5：RPC 服务映射来源 + 插件/Agent 服务获取） */
  serviceRegistry?: ServiceRegistry;
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
      uploadDir: options.uploadDir ?? path.join(configService.getGlobalConfig().workspaceDir, 'files'),
      staticDir: options.staticDir ?? path.resolve(__dirname, '..', 'client', 'dist'),
      dataDir: options.dataDir ?? configService.getGlobalConfig().workspaceDir,
      router: options.router,
      registry: options.registry,
      historyService: options.historyService,
      GroupManager: options.GroupManager,
      serviceRegistry: options.serviceRegistry,
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
    // Agent 管理：AgentService 经服务注册表获取（v0.5.0 收敛：webui 只 import services）
    this.app.use('/api/agents', createAgentsRouter(
      this.options.registry,
      this.options.serviceRegistry?.get('agentService') as AgentService | undefined,
      this.options.router,
    ));
    this.app.use('/api/history', createHistoryRouter(this.options.historyService));
    this.app.use('/api/upload', createUploadRouter(this.options.uploadDir));
    this.app.use('/api/config', createConfigRouter());

    // 插件管理路由（插件发现引擎 PluginLoader 经服务注册表获取）
    const pluginLoader = this.options.serviceRegistry?.get('pluginLoader') as PluginManager | undefined;
    if (pluginLoader) {
      this.app.use('/api/plugins', createPluginsRouter(pluginLoader));
    }

    // 文件浏览路由（打开原生文件选择对话框）
    this.app.use('/api/browse', createBrowseRouter());

    // 工作区文件预览路由
    this.app.use('/api/workspace', createWorkspaceRouter());

    // 数据备份路由（手工触发 + 列表）
    this.app.use('/api/backup', createBackupRouter());

    // 版本信息路由
    this.app.use('/api/version', createVersionRouter());

    // Token 用量路由
    this.app.use('/api/usage', createUsageRouter());

    // 会话 Token 预测路由
    this.app.use('/api/sessions', createSessionRouter());

    // 群组路由（GroupService 经服务注册表获取，v0.5.0 收敛：webui 只 import services）
    const groupService = this.options.serviceRegistry?.get('groupService') as GroupService | undefined;
    if (groupService) {
      this.app.use('/api/groups', createGroupsRouter(groupService));
    }

    // WebSocket 处理
    this.wsHandler = new WSHandler({
      router: this.options.router,
      registry: this.options.registry,
      messageQuery: this.options.historyService,
      GroupManager: this.options.GroupManager,
      dataDir: this.options.dataDir,
      rpc: this.buildRPC(),
      agentService: this.options.serviceRegistry?.get('agentService') as AgentService | undefined,
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
  /**
   * 构建 RPC 桥（v0.5.0 P5）：从 ServiceRegistry 注册的服务映射 RPC 方法。
   * 服务通过 registerService(name, svc) 自动注册其公开方法为 "name.method"。
   */
  private buildRPC(): RPCBridge | undefined {
    const reg = this.options.serviceRegistry;
    if (!reg) return undefined;
    const rpc = new RPCBridge(reg);
    // 注册已注册的服务（agentService/messageQuery）
    const agentService = reg.get('agentService');
    if (agentService) rpc.registerService('agent', agentService as object);
    const messageQuery = reg.get('messageQuery');
    if (messageQuery) rpc.registerService('history', messageQuery as object);
    return rpc;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, '::', () => {
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
   * 主动断开 WS 连接 + 超时兜底（活跃连接会让 server.close 永久挂起）
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
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
        else resolve();
      });
    });
  }
}
