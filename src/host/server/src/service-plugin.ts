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
import { WorkspacesService } from './workspaces';
import { makeSingleTitleHook } from './singles-title';
import { buildSystemPromptWithPersona } from '@agentchat/agent-persona';
import type { AgentPresetsService } from '@agentchat/agent-presets';
import { createAgentPresetsRouter } from './api/agent-presets';
import { InteractionBridge, setInteractionBridge } from './interactions';
import { recoverInteractionHistory } from './interaction-recovery';
import { initRuntime } from './runtime';
import type { DurableInteractionService } from '@agentchat/durable-interaction';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import type { SourceTagContract } from '@agentchat/contracts';
import { counterpartOfDialog, groupIdOfDialog, isGroupDialog } from '@agentchat/agents';
import {
  AgentServiceFacade, ConfigServiceFacade, GroupServiceFacade, HistoryServiceFacade,
} from './service';
import { configService } from './config-service';
import type { TimerService } from '@agentchat/timer';
import type { SubAgentService } from '@agentchat/subagent';
import type { ArchiveHostService } from '@agentchat/archive';
import type { PluginServices } from '@agentchat/tools';
import { createAgentsRouter } from './api/agents';
import { createGroupsRouter } from './api/groups';
import { createHistoryRouter } from './api/history';
import { createSinglesRouter } from './api/singles';
import { createWorkspacesRouter } from './api/workspaces';
import { createRunsRouter } from './api/runs';

export const name = 'agentchat-server-services';
export const inject = ['bootstrap', 'workspace', 'timerManager', 'subagent', 'archive', 'http', 'durableInteraction', 'hooks', 'agentPresets'];

/** 自动续推来源标签（kind='continue'）：ws chat.continue 的入站形态（本行是生产方） */
const CONTINUE_SOURCE_TAG: SourceTagContract = {
  kind: 'continue',
  tag: () => '[自动续推]',
  contractSection: [
    '## 消息来源：自动续推',
    '- user 消息正文首行的 `[自动续推]` 标签表示上轮自动续推信号：继续未完成的工作。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};

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
  /** 用户工作区（会话树分组的文件夹白名单） */
  workspacesService: WorkspacesService;
  /** 预设 Agent 注册中心（/api/agent-presets 数据源） */
  agentPresets: AgentPresetsService;
  /** 默认预设 id（空 Agent 独立会话的路由目标） */
  defaultPresetId: string;
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
  readonly workspacesService: WorkspacesService;
  readonly agentPresets: AgentPresetsService;
  readonly defaultPresetId: string;

  constructor(ctx: Context, deps: ServerServices) {
    super(ctx, 'l4');
    this.interactionBridge = deps.interactionBridge;
    this.serviceRegistry = deps.serviceRegistry;
    this.rpc = deps.rpc;
    this.agentService = deps.agentService;
    this.groupService = deps.groupService;
    this.historyService = deps.historyService;
    this.singlesService = deps.singlesService;
    this.workspacesService = deps.workspacesService;
    this.agentPresets = deps.agentPresets;
    this.defaultPresetId = deps.defaultPresetId;
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
  // 用户工作区（会话树分组）：workspaces/<id>/workspace.json（文件夹白名单登记）
  const workspacesService = new WorkspacesService({ wsRoot: core.workspaceDir });
  const singlesService = new SinglesService({
    wsRoot: core.workspaceDir,
    registry: core.registry,
    llmPools: () => (configService.getGlobalConfig().llmProviders ?? {}) as Record<string, unknown>,
    workspaces: workspacesService,
  });
  serviceRegistry.register('singlesService', singlesService);
  serviceRegistry.register('workspacesService', workspacesService);

  // 预设 Agent 物化（DSH agent-presets 形态）：ctx.agentPresets 的定义 →
  // AgentRegistry（preset:true，Agent 列表过滤；llm 缺省 → 全局默认池引用）。
  // 空 Agent 独立会话的路由目标 = 默认预设（如内置「空白」）。
  const presetsSvc = ctx.agentPresets as AgentPresetsService;
  const poolEntries = Object.entries((configService.getGlobalConfig().llmProviders ?? {}) as Record<string, any>)
    .filter(([k]) => !k.startsWith('$'));
  const defPool = poolEntries.find(([, v]) => v && (v as any).default)?.[0] ?? poolEntries[0]?.[0];
  for (const def of presetsSvc.list()) {
    if (core.registry.has(def.agent.agent_id)) continue;
    const cfg = { ...def.agent, preset: true } as typeof def.agent;
    if (!cfg.llm && defPool) cfg.llm = defPool;
    core.registry.register(cfg);
  }
  const defaultPresetId = presetsSvc.defaultPreset()?.agent.agent_id ?? '';
  ctx.logger('server').info(`预设 Agent 就绪（${presetsSvc.list().length} 个，默认：${defaultPresetId || '（无）'}，默认池：${defPool ?? '全局兜底'}）`);

  // system prompt 组装服务（与运行时钩子链同构：build-system-prompt + persona
  // 前置注入；AgentService.getAgentSystemPrompt 经 L4 注册表取用——缺失时前端
  // 预览报 "服务未注册"（P3 前遗留 bug），此处注册补齐）
  serviceRegistry.register('buildSystemPrompt', buildSystemPromptWithPersona);

  // 独立会话自动标题（stepEnd 钩子，automatic：不受 config.hooks 清单控制；
  // 首个推理步结束时 LLM 生成标题 → singles.updated 事件 → WS 广播前端刷新）
  ctx.hooks?.register('stepEnd', 'singles.auto-title', () => makeSingleTitleHook(
    singlesService,
    (session) => { try { core.router.emit('singles.updated', { session }); } catch { /* 广播失败不阻塞 */ } },
  ), undefined, true);

  // 续推域来源标签钩子（chat.continue 生产方注册；ownerless automatic）
  ctx.hooks?.register('stepStart', 'server.continue-source-tag', () => makeSourceTagStepStartHook(CONTINUE_SOURCE_TAG), undefined, true);
  ctx.hooks?.register('runStart', 'server.continue-source-contract', () => makeSourceContractRunStartHook(CONTINUE_SOURCE_TAG), undefined, true);

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
    workspacesService,
    agentPresets: presetsSvc,
    defaultPresetId,
  });

  // 5. 业务域 HTTP 路由（L3：本插件行注册自己的 /api/*，挂/摘插件行即挂/摘路由）
  const routeDisposers = [
    ctx.http.register('/api/agents', createAgentsRouter(agentService)),
    ctx.http.register('/api/history', createHistoryRouter(historyService)),
    ctx.http.register('/api/groups', createGroupsRouter(groupService)),
    ctx.http.register('/api/singles', createSinglesRouter(singlesService)),
    ctx.http.register('/api/workspaces', createWorkspacesRouter(workspacesService)),
    ctx.http.register('/api/agent-presets', createAgentPresetsRouter(presetsSvc)),
    // Agent 运行跟踪：矩阵成员/会话盘存/运行中 run/子 Agent 快照 + 会话中断
    ctx.http.register('/api/runs', createRunsRouter({
      router: core.router,
      registry: core.registry,
      groups: () => groupService.listGroupsWithActivity(),
      singles: singlesService,
      subAgent: subAgent ?? null,
      wsRoot: core.workspaceDir,
    })),
  ];

  ctx.logger('server').info('L4 门面由 server 插件行持有（agent/group/history/singles/workspaces/presets/rpc/interaction/serviceRegistry + /api/{agents,history,groups,singles,workspaces,agent-presets,runs}）');
  return () => routeDisposers.forEach((dispose) => dispose());
}
