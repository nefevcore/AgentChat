// ============================================================
// @agentchat/server/src/service.ts —— 宿主/门面服务（cordis Service）
//
// 全面 cordis 化：ctx.server 暴露 WebUI Server；L4 门面（Agent/Group/
// History/Config 服务）以 ctx.<service> 形式暴露，供插件与上层取用。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { WebUIServer } from './webui-server';
import { AgentService } from './agent-service';
import { GroupService } from './group-service';
import { HistoryService } from './history-service';
import { ConfigService } from './config-service';
import type { ServiceRegistry } from './registry';

export class ServerService extends Service {
  /** WebUI Server 实例（HTTP + WS + JSON-RPC + 事件桥） */
  readonly server: WebUIServer;

  constructor(ctx: Context, server: WebUIServer) {
    super(ctx, 'server');
    this.server = server;
  }

  /** 停止 WebUI（委托实例；bootstrap 已启动，stop 供优雅关闭） */
  async stop(): Promise<void> {
    return this.server.stop();
  }
}

/**
 * boot 提供给 @agentchat/webui 插件行的宿主服务：
 * WebUI 插件 inject webServerHost，拿到 ServiceRegistry/工作区/端口后自行启动服务器。
 * 这使 WebUI 本体成为 cordis 插件（对应 DSH 的 webui 插件模型）。
 */
export class WebServerHostService extends Service {
  readonly serviceRegistry: ServiceRegistry;
  readonly dataDir: string;
  readonly port: number;
  /** 宿主是否启用 WebUI（boot config enableWebUI / AGENTCHAT_NO_WEBUI） */
  readonly enabled: boolean;

  constructor(ctx: Context, serviceRegistry: ServiceRegistry, dataDir: string, port: number, enabled = true) {
    super(ctx, 'webServerHost');
    this.serviceRegistry = serviceRegistry;
    this.dataDir = dataDir;
    this.port = port;
    this.enabled = enabled;
  }
}

/** ctx.agentService —— Agent 管理门面 */
export class AgentServiceFacade extends Service {
  readonly service: AgentService;
  constructor(ctx: Context, service: AgentService) {
    super(ctx, 'agentService');
    this.service = service;
  }
}

/** ctx.groupService —— 群组门面 */
export class GroupServiceFacade extends Service {
  readonly service: GroupService;
  constructor(ctx: Context, service: GroupService) {
    super(ctx, 'groupService');
    this.service = service;
  }
}

/** ctx.historyService —— 历史查询门面 */
export class HistoryServiceFacade extends Service {
  readonly service: HistoryService;
  constructor(ctx: Context, service: HistoryService) {
    super(ctx, 'historyService');
    this.service = service;
  }
}

/** ctx.configService —— 配置门面 */
export class ConfigServiceFacade extends Service {
  readonly service: ConfigService;
  constructor(ctx: Context, service: ConfigService) {
    super(ctx, 'configService');
    this.service = service;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** WebUI Server（HTTP+WS+JSON-RPC；由 @agentchat/webui 插件行提供） */
    server: ServerService;
    /** WebUI 宿主依赖（boot 提供；@agentchat/webui inject 后启动 HTTP/WS） */
    webServerHost?: WebServerHostService;
    /** Agent 管理门面（REST/RPC 消费） */
    agentService: AgentServiceFacade;
    /** 群组门面 */
    groupService: GroupServiceFacade;
    /** 历史查询门面 */
    historyService: HistoryServiceFacade;
    /** 配置门面 */
    configService: ConfigServiceFacade;
  }
}
