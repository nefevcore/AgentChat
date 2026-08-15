// ============================================================
// @agentchat/server/src/service-plugin.ts —— L4 门面服务插件行（块 A）
//
// 由本行构造（boot 不再 new）：
//   InteractionBridge / ServiceRegistry / RPCBridge /
//   AgentService / GroupService / HistoryService + ctx 门面包装。
// 依赖顺序由 inject 保证：workspace 已初始化并注册 Agent，
// timer/subagent/archive 已把 Manager 写入 boot 契约的 PluginServices。
//
// 注意：PluginManager（makePluginManager）仍留在 boot 的装配层，
// 由 boot-finalize 在本行提供的 ServiceRegistry 上注册。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { AgentLoaderLike } from './agent-service';
import { AgentService } from './agent-service';
import { GroupService } from './group-service';
import { HistoryService } from './history-service';
import { ServiceRegistry } from './registry';
import { RPCBridge } from './rpc';
import { InteractionBridge, setInteractionBridge } from './interactions';
import { initRuntime } from './runtime';
import {
  AgentServiceFacade, ConfigServiceFacade, GroupServiceFacade, HistoryServiceFacade,
} from './service';
import { configService } from './config-service';
import type { TimerService } from '@agentchat/timer';
import type { SubAgentService } from '@agentchat/subagent';
import type { ArchiveHostService } from '@agentchat/archive/src/plugin';
import type { PluginServices } from '@agentchat/tools';
import { createAgentsRouter } from './api/agents';
import { createGroupsRouter } from './api/groups';
import { createHistoryRouter } from './api/history';

export const name = 'agentchat-server-services';
export const inject = ['bootstrap', 'workspace', 'timerManager', 'subagent', 'archive', 'http'];

/** boot 核心契约的最小结构（避免 server → boot 静态环） */
interface BootstrapRuntime {
  services: PluginServices;
  globalConfig: Record<string, any>;
  workspaceDir: string;
  router: any;
  registry: any;
  loader: AgentLoaderLike;
  srcRoot: string;
}

export interface ServerServices {
  interactionBridge: InteractionBridge;
  serviceRegistry: ServiceRegistry;
  rpc: RPCBridge;
  agentService: AgentService;
  groupService: GroupService;
  historyService: HistoryService;
}

/** ctx.l4 —— L4 门面聚合（boot-finalize / HTTP 路由插件消费） */
export class ServerServicesHost extends Service {
  readonly interactionBridge: InteractionBridge;
  readonly serviceRegistry: ServiceRegistry;
  readonly rpc: RPCBridge;
  readonly agentService: AgentService;
  readonly groupService: GroupService;
  readonly historyService: HistoryService;

  constructor(ctx: Context, deps: ServerServices) {
    super(ctx, 'l4');
    this.interactionBridge = deps.interactionBridge;
    this.serviceRegistry = deps.serviceRegistry;
    this.rpc = deps.rpc;
    this.agentService = deps.agentService;
    this.groupService = deps.groupService;
    this.historyService = deps.historyService;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** L4 门面聚合（@agentchat/server 插件行提供） */
    l4: ServerServicesHost;
  }
}

export function apply(ctx: Context) {
  const core = ctx.bootstrap as BootstrapRuntime;
  const timer = (ctx.timerManager as TimerService | undefined)?.manager;
  const subAgent = (ctx.subagent as SubAgentService | undefined)?.manager;
  const archive = (ctx.archive as ArchiveHostService | undefined)?.manager;

  // 1. 运行时门面 + 交互桥（router 事件总线 → L4 可 import 的全局门面）
  initRuntime({
    router: core.router,
    requestRestart: () => {},
    globalConfig: core.globalConfig,
  });
  const interactionBridge = new InteractionBridge(core.router);
  setInteractionBridge(interactionBridge);
  core.services.interaction = interactionBridge;

  // 2. ServiceRegistry + L4 门面构造（业务 new 收敛在本插件行）
  const serviceRegistry = new ServiceRegistry();
  const agentService = new AgentService({
    registry: core.registry,
    loader: core.loader,
    agentRouter: core.router,
    ctx,
    timer,
    pluginServices: core.services,
    serviceRegistry,
  });
  serviceRegistry.register('agentService', agentService);

  const groupService = new GroupService(core.router.getGroupManager(), core.workspaceDir);
  groupService.loadGroupsFromDisk();
  serviceRegistry.register('groupService', groupService);

  const historyService = new HistoryService({
    wsRoot: core.workspaceDir,
    archive: (agent, counterpart) => archive?.requestArchive(agent, counterpart),
  });
  serviceRegistry.register('historyService', historyService);

  // 3. ctx 门面（WebUI/插件经 ctx.get 可选读取）
  new AgentServiceFacade(ctx, agentService);
  new GroupServiceFacade(ctx, groupService);
  new HistoryServiceFacade(ctx, historyService);
  new ConfigServiceFacade(ctx, configService);

  // 4. RPC 桥（agent/group/history → "name.method" 方法清单）
  const rpc = new RPCBridge(serviceRegistry);
  rpc.registerService('agent', agentService);
  rpc.registerService('group', groupService);
  rpc.registerService('history', historyService);

  new ServerServicesHost(ctx, {
    interactionBridge,
    serviceRegistry,
    rpc,
    agentService,
    groupService,
    historyService,
  });

  // 5. 业务域 HTTP 路由（L3：本插件行注册自己的 /api/*，挂/摘插件行即挂/摘路由）
  const routeDisposers = [
    ctx.http.register('/api/agents', createAgentsRouter(agentService)),
    ctx.http.register('/api/history', createHistoryRouter(historyService)),
    ctx.http.register('/api/groups', createGroupsRouter(groupService)),
  ];

  ctx.logger('server').info('L4 门面由 server 插件行持有（agent/group/history/rpc/interaction/serviceRegistry + /api/{agents,history,groups}）');
  return () => routeDisposers.forEach((dispose) => dispose());
}
