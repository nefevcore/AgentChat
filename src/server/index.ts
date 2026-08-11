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
import { createLogger } from '@core/logger';
const logger = createLogger('[server]');
import { configService } from '@services/config-service';
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
import { ServiceRegistry, HistoryService, AgentService, GroupService } from '@services/index';
import { RPCBridge } from '@services/rpc';

export interface WebUIServerOptions {
  /** 服务注册表（唯一装配入口：agentService/groupService/historyService/pluginManager 等均经此发现） */
  serviceRegistry: ServiceRegistry;
  /** 数据目录路径 */
  dataDir?: string;
  port?: number;
  /** 文件上传目录 */
  uploadDir?: string;
  /** 静态文件目录（前端构建产物） */
  staticDir?: string;
  /** 是否托管前端静态文件（默认：staticDir 存在即托管；不存在则纯 API 降级） */
  serveStatic?: boolean;
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

  constructor(options: WebUIServerOptions) {
    const staticDir = options.staticDir ?? path.resolve(__dirname, '..', 'ui', 'webui', 'dist');
    // 默认行为：前端构建产物存在即托管（dev/prod 一视同仁，桌面端/单进程场景后端自包含）；不存在则纯 API 降级
    const serveStatic = options.serveStatic ?? require('fs').existsSync(staticDir);

    this.options = {
      port: options.port ?? 3830,
      uploadDir: options.uploadDir ?? path.join(configService.getGlobalConfig().workspaceDir, 'files'),
      staticDir,
      dataDir: options.dataDir ?? configService.getGlobalConfig().workspaceDir,
      serveStatic,
    } as Required<Omit<WebUIServerOptions, 'serviceRegistry'>>;

    // ---- L4 服务发现：全部经 ServiceRegistry（唯一装配入口，无直接传参） ----
    // 服务在 L5 bootstrap 注册；server 只 import services 类型 + 注册表，解耦装配。
    const reg = options.serviceRegistry;
    this.historyService = reg.require<HistoryService>('historyService');
    this.agentService = reg.get<AgentService>('agentService');
    this.groupService = reg.get<GroupService>('groupService');

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

    // 注册 API 路由（各服务均经注册表发现）
    this.app.use('/api/agents', createAgentsRouter(this.agentService));
    this.app.use('/api/history', createHistoryRouter(this.historyService));
    this.app.use('/api/upload', createUploadRouter(this.options.uploadDir));
    this.app.use('/api/config', createConfigRouter());

    // 插件管理路由（插件管理适配器经服务注册表发现，替代旧 PluginLoader）
    const pluginLoader = reg.get('pluginManager') as PluginManager | undefined;
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

    // 群组路由（GroupService 经服务注册表发现）
    if (this.groupService) {
      this.app.use('/api/groups', createGroupsRouter(this.groupService));
    }

    // WebSocket 处理（Router/Registry/GroupManager 经 services/runtime 门面获取）
    this.wsHandler = new WSHandler({
      messageQuery: this.historyService,
      historyService: this.historyService, // 归档/压缩等历史服务操作（v0.5.0 审查修复）
      dataDir: this.options.dataDir,
      rpc: this.buildRPC(reg),
      agentService: this.agentService,
      groupService: this.groupService,
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
        else resolve();
      });
    });
  }
}
