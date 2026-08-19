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
import * as path from 'node:path';
import type { AgentLoaderLike } from './agent-service';
import { AgentService } from './agent-service';
import { GroupService } from './group-service';
import { HistoryService } from './history-service';
import { ServiceRegistry } from './registry';
import { RPCBridge } from './rpc';
import { SinglesService } from './singles';
import { InteractionBridge, setInteractionBridge } from './interactions';
import { recoverInteractionHistory } from './interaction-recovery';
import { initRuntime } from './runtime';
import type { DurableInteractionService } from '@agentchat/durable-interaction';
import { counterpartOfDialog, groupIdOfDialog, isGroupDialog } from '@agentchat/agents';
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
import { createSinglesRouter } from './api/singles';

export const name = 'agentchat-server-services';
export const inject = ['bootstrap', 'workspace', 'timerManager', 'subagent', 'archive', 'http', 'durableInteraction'];

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
  singlesService: SinglesService;
}

/** ctx.l4 —— L4 门面聚合（boot-finalize / HTTP 路由插件消费） */
export class ServerServicesHost extends Service {
  readonly interactionBridge: InteractionBridge;
  readonly serviceRegistry: ServiceRegistry;
  readonly rpc: RPCBridge;
  readonly agentService: AgentService;
  readonly groupService: GroupService;
  readonly historyService: HistoryService;
  readonly singlesService: SinglesService;

  constructor(ctx: Context, deps: ServerServices) {
    super(ctx, 'l4');
    this.interactionBridge = deps.interactionBridge;
    this.serviceRegistry = deps.serviceRegistry;
    this.rpc = deps.rpc;
    this.agentService = deps.agentService;
    this.groupService = deps.groupService;
    this.historyService = deps.historyService;
    this.singlesService = deps.singlesService;
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

  // 1.5 通用 durable-interaction 服务适配：jsonl 后端落在工作区（跨重启恢复 pending）
  const durable = ctx.durableInteraction as DurableInteractionService;
  try {
    durable.configure({
      backend: 'jsonl',
      file: path.join(core.workspaceDir, '.durable-interactions.jsonl'),
      fsync: true,
    });
  } catch (err: any) {
    ctx.logger('server').warn(`durable-interaction jsonl 后端初始化失败，降级 memory: ${err?.message ?? String(err)}`);
  }

  const resumeLateReply = (record: { owner?: string; key: string }) => {
    const agentId = record.owner;
    if (!agentId) return;
    try {
      const triggerOptions: Record<string, unknown> = {
        source: 'interaction-resume',
        sourceMeta: { kind: 'system', form: 'notice', summary: '交互已回答' },
        hint: '之前的提问用户已经回答，请继续处理并给出最终回复。',
      };
      if (isGroupDialog(record.key)) {
        triggerOptions.group_id = groupIdOfDialog(record.key);
      } else {
        triggerOptions.target = counterpartOfDialog(record.key, agentId) || 'user';
      }
      void core.router.trigger(agentId, triggerOptions);
    } catch (err: any) {
      ctx.logger('server').warn(`late interaction reply 唤醒失败（${record.key}）: ${err?.message ?? String(err)}`);
    }
  };

  const interactionBridge = new InteractionBridge(core.router, durable, { onLateReply: resumeLateReply });
  setInteractionBridge(interactionBridge);
  core.services.interaction = interactionBridge;

  // 1.6 历史恢复调和：agent-session 加载历史后，把 answered 的 ask_questions
  //     悬空 tool_call 合成 tool 结果；pending 保留悬空（由 WS 层 park 阻止新 run）。
  core.services.recoverHistory = (history) => recoverInteractionHistory(durable, history);

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

  // 单通道化 v3（docs/group-single-channel-design.md §3 Phase 2）：绑定群消息内容通道。
  // 模式读全局配置 group 节（workspace/config.json：{"group":{"delivery":"notify","deliveryVariant":"history"}}），
  // 缺省 legacy——notify 需显式开启；groupFeed 未注入时 Router 自动回落 legacy（失效安全侧）。
  // Phase 2.5 本体轮转：group.archiveTokens / group.keepTokens（缺省 500000 / 30000）。
  // 变更需重启（热重载不重绑）。
  const groupCfg = (configService.getGlobalConfig() as {
    group?: {
      delivery?: 'legacy' | 'notify';
      deliveryVariant?: 'tail' | 'history';
      archiveTokens?: number;
      keepTokens?: number;
    };
  }).group ?? {};
  const groupService = new GroupService(core.router.getGroupManager(), core.workspaceDir, {
    ...(groupCfg.archiveTokens ? { archiveTokens: groupCfg.archiveTokens } : {}),
    ...(groupCfg.keepTokens ? { keepTokens: groupCfg.keepTokens } : {}),
  });
  groupService.loadGroupsFromDisk();
  serviceRegistry.register('groupService', groupService);
  core.router.applyGroupDelivery({
    groupFeed: groupService,
    ...(groupCfg.delivery ? { delivery: groupCfg.delivery } : {}),
    ...(groupCfg.deliveryVariant ? { deliveryVariant: groupCfg.deliveryVariant } : {}),
  });

  const historyService = new HistoryService({
    wsRoot: core.workspaceDir,
    archive: (agent, counterpart) => archive?.requestArchive(agent, counterpart),
  });
  serviceRegistry.register('historyService', historyService);

  // 独立会话（P3 single session）：元数据 singles/<id>/session.json + 消息走
  // 标准会话链 sessions/single~<id>/（模型池校验读全局配置 llmProviders）
  const singlesService = new SinglesService({
    wsRoot: core.workspaceDir,
    registry: core.registry,
    llmPools: () => (configService.getGlobalConfig().llmProviders ?? {}) as Record<string, unknown>,
  });
  serviceRegistry.register('singlesService', singlesService);

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
    singlesService,
  });

  // 5. 业务域 HTTP 路由（L3：本插件行注册自己的 /api/*，挂/摘插件行即挂/摘路由）
  const routeDisposers = [
    ctx.http.register('/api/agents', createAgentsRouter(agentService)),
    ctx.http.register('/api/history', createHistoryRouter(historyService)),
    ctx.http.register('/api/groups', createGroupsRouter(groupService)),
    ctx.http.register('/api/singles', createSinglesRouter(singlesService)),
  ];

  ctx.logger('server').info('L4 门面由 server 插件行持有（agent/group/history/singles/rpc/interaction/serviceRegistry + /api/{agents,history,groups,singles}）');
  return () => routeDisposers.forEach((dispose) => dispose());
}
