// ============================================================
// @agentchat/boot/src/bootstrap-core.ts —— 最小装配契约（L2 拆环）
//
// boot 只做"契约接线"：@agentchat/boot/src/plugin 创建
//   assembly / router / registry / loader / PluginServices 共享实例，
//   并以 ctx.bootstrap 服务暴露给 workspace/archive/timer/subagent/server
//   等服务插件。各业务服务由拥有它的插件自行构造，boot-finalize 最后接线。
//
// 拆环依据（docs/preview-knowledge-base.md §4）：
//   core 提供服务 → 域插件消费 → finalize 消费全部域服务。
//   域插件彼此不直接依赖，全部经 PluginServices（ToolContext）共享实例汇合。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { AgentRegistry, AgentAssembly } from '@agentchat/agents';
import type { AgentRouter } from '@agentchat/router';
import type { PluginServices } from '@agentchat/tools';
import type { AgentLoader } from './loader';
import type { PluginEventBus } from '@agentchat/server';
import type { PluginHost } from '@agentchat/plugins';

export interface BootstrapCoreConfig {
  workspace?: string;
}

/**
 * boot 核心装配契约。所有域服务插件 inject ['bootstrap'] 读取：
 *   · globalConfig / workspaceDir / agentsDir —— 构造各自服务的路径参数
 *   · router / registry —— 事件总线接线与 Agent 查询
 *   · services —— ToolContext/PluginServices 共享实例（assembly 与工具烘焙共用）
 *   · loadAgents() —— 工作区初始化（workspace 插件）完成后扫描注册 Agent
 */
export class BootstrapCoreService extends Service {
  readonly globalConfig: Record<string, any>;
  readonly services: PluginServices;
  readonly assembly: AgentAssembly;
  readonly router: AgentRouter;
  readonly registry: AgentRegistry;
  readonly loader: AgentLoader;
  readonly srcRoot: string;
  readonly pluginEvents: PluginEventBus;
  readonly pluginHost: PluginHost;

  /** 由 workspace 插件负责调用（保证默认 user/admin 已落盘后才扫描） */
  loadAgents: () => void = () => {};

  /** 服务插件完成构造后把自身写入 services（assembly 每次投递重新烘焙时读取） */
  get workspaceDir(): string {
    return this.globalConfig.workspaceDir;
  }

  get agentsDir(): string {
    return this.globalConfig.agentsDir;
  }

  constructor(
    ctx: Context,
    deps: {
      globalConfig: Record<string, any>;
      services: PluginServices;
      assembly: AgentAssembly;
      router: AgentRouter;
      loader: AgentLoader;
      pluginEvents: PluginEventBus;
      pluginHost: PluginHost;
      srcRoot: string;
    },
  ) {
    super(ctx, 'bootstrap');
    this.globalConfig = deps.globalConfig;
    this.services = deps.services;
    this.assembly = deps.assembly;
    this.router = deps.router;
    this.registry = deps.router.getRegistry();
    this.loader = deps.loader;
    this.pluginEvents = deps.pluginEvents;
    this.pluginHost = deps.pluginHost;
    this.srcRoot = deps.srcRoot;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** boot 核心装配契约（assembly/router/registry/loader/services） */
    bootstrap: BootstrapCoreService;
  }
}
