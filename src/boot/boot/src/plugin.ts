// ============================================================
// @agentchat/boot/src/plugin.ts —— boot 核心装配行（L2）
//
// 职责（块 A 之后）：
//   1. 核心服务（ctx.llm/tools/hooks）：Loader 场景由能力行提供，
//      无 Loader 场景 registerCoreServices 兜底。
//   2. 创建最小装配契约：Assembly / Router / Registry / AgentLoader /
//      PluginServices 共享实例，注册为 ctx.bootstrap。
//   3. 扫描全局插件库（workspace/plugins registry）。
//
// 不再承担：workspace 初始化、timer/subagent/archive/L4 门面的构造——
//   这些业务服务由各自插件行持有，boot-finalize 行最后接线。
// ============================================================
import * as path from 'path';
import type { Context } from '@agentchat/cordis';
import { AgentsService } from '@agentchat/agents';
import { AgentRouter } from '@agentchat/router';
import type { PluginServices } from '@agentchat/tools';
import { PluginEventBus } from '@agentchat/server';
import { getOrCreatePluginHost, loadInstalledPlugins } from '@agentchat/plugins';
import { registerCoreServices } from './register-core';
import { makeAgentAssembly, loadGlobalConfig, AgentLoader } from './loader';
import { BootstrapCoreService } from './bootstrap-core';

export const name = 'agentchat-bootstrap-core';

/** 核心装配依赖：agentLoop/llm/tools/hooks 由能力插件行提供（Loader 排序） */
export const inject = ['agentLoop', 'llm', 'tools', 'hooks'];

export interface Config {
  /** 工作区（默认 AGENTCHAT_WORKSPACE 或 workspace/default） */
  workspace?: string;
}

export async function apply(ctx: Context, config: Config = {}) {
  const logger = ctx.logger('boot');

  // 1. 核心服务 + 能力插件：
  //    Loader 场景（cordis.yml 行）：ctx.llm/tools/hooks 已由能力行提供，
  //    inject 保证就绪 → 跳过 registerCoreServices（避免重复注册）。
  //    无 Loader 场景（直接 ctx.plugin(bootPlugin)）：兜底创建。
  if (!ctx.llm || !ctx.tools || !ctx.hooks) {
    await registerCoreServices(ctx);
  }

  // 2. 全局配置（workspace/config.json + 默认值）
  const globalConfig = loadGlobalConfig(config.workspace);

  // 3. 插件域事件总线 + ctx.pluginHost 服务接线（boot/扫描/dev 工具/HTTP 共用同一实例）
  const pluginEvents = new PluginEventBus();
  const pluginHost = getOrCreatePluginHost(ctx);
  pluginHost.attachEventSink((type, data) => {
    pluginEvents.emitEvent(type as any, data as any);
  });

  // 4. 全局插件库扫描：已安装插件先于 Agent 装配挂到 ctx
  try {
    await loadInstalledPlugins(ctx, globalConfig.workspaceDir);
  } catch (err: any) {
    logger.warn(`[Bootstrap] 全局插件库扫描失败（继续启动）: ${err?.message ?? String(err)}`);
  }

  // 5. 最小装配契约：assembly → router → registry
  const services: PluginServices = {};
  const getRouter = () => router;
  const assembly = makeAgentAssembly({
    getRouter,
    services,
    globalConfig,
    ctx,
  });
  const router = new AgentRouter(assembly);
  const registry = router.getRegistry();
  services.router = router;
  services.workspaceDir = globalConfig.workspaceDir;
  services.agentsDir = globalConfig.agentsDir;
  services.searchProviders = globalConfig.searchProviders;

  const loader = new AgentLoader(globalConfig);

  // 6. reload-requested 中断的执行体（createAgentContext 将其装配为 interruptHandler）
  assembly.reloadAgents = (scope, config) => {
    const reloadAgent = (agentId: string) => {
      try {
        const loaded = loader.loadOne(path.join(globalConfig.agentsDir, agentId));
        registry.register(loaded.config);
        logger.info(`[Reload] Agent "${agentId}" 已热重载`);
      } catch (err: any) {
        logger.warn(`[Reload] Agent "${agentId}" 热重载失败: ${err?.message ?? String(err)}`);
      }
    };
    if (scope === 'self' || scope === 'all') {
      reloadAgent(config.agent_id);
    }
    if (scope === 'global' || scope === 'all') {
      for (const id of registry.listIds()) reloadAgent(id);
    }
  };
  assembly.requestRestart = (reason) => {
    // 延迟 import，避免 boot core 行静态依赖 shutdown（supervisor/桌面入口）。
    // requestRestart 在 boot-finalize 接线后才会被 Agent 工具触发。
    return import('./shutdown').then((m) => m.requestRestart(reason));
  };

  // 7. ctx.bootstrap 契约 + ctx.agents（Agent 由 workspace 插件初始化后扫描）
  new AgentsService(ctx, router, registry);
  const core = new BootstrapCoreService(ctx, {
    globalConfig,
    services,
    assembly,
    router,
    loader,
    pluginEvents,
    pluginHost,
    srcRoot: path.resolve(process.cwd()),
  });

  core.loadAgents = () => {
    const loadedAgents = loader.loadAll();
    for (const { config } of loadedAgents) {
      registry.register(config);
    }
    if (registry.size === 0) {
      logger.warn('[Bootstrap] 未找到任何 Agent，请检查是否创建了 config.json 文件');
    }
    logger.info(`[Bootstrap] ${registry.size} agents registered: ${registry.listIds().join(', ')}`);
  };

  logger.info('boot 核心装配就绪（ctx.bootstrap：assembly/router/registry/loader/services）');
}
