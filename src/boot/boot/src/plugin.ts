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
import type { AgentMessage } from '@agentchat/types';
import { AgentsService } from '@agentchat/agents';
import { AgentRouter } from '@agentchat/router';
import type { PluginServices } from '@agentchat/tools';
import { PluginEventBus } from '@agentchat/server';
import { getOrCreatePluginHost, loadInstalledPlugins } from '@agentchat/plugins';
import { registerCoreServices } from './register-core';
import { makeAgentAssembly, loadGlobalConfig, AgentLoader } from './loader';
import { BootstrapCoreService } from './bootstrap-core';

export const name = 'agentchat-bootstrap-core';

/** 核心装配依赖：agentLoop/llm/tools/hooks/jobs 由能力插件行提供（Loader 排序） */
export const inject = ['agentLoop', 'llm', 'tools', 'hooks', 'jobs'];

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

  // 后台任务完成通知（Phase 2，docs/tool-design-roadmap.md §7.1）：
  // ctx.jobs 任务 settle 时（bash completed/killed、subagent done/error/timeout/killed）
  // 双通道送达：
  //   1. router 'message' 事件（type: job.done）→ WS 广播（前端通知）；
  //   2. 完成通知进 owner inbox（router.followup，DSH 式 notice）：
  //      以 role='user' + source{kind:'system', form:'notice'} 入队 next-turn，
  //      空闲时开新 run，忙时在 run 结束后消费——跨回合必达；
  //      自主来源受 router MAX_AUTO_WAKES 兜底（防"完成→自触发→再完成"自激），
  //      通知 run 以 delivery.maxSteps=8 封顶（防止 notice 触发长自主任务）。
  ctx.jobs.onJobDone((job) => {
    const owner = job.meta?.ownerAgentId as string | undefined;
    const summary = `后台任务 ${job.id}（${job.kind}）${job.status === 'killed' ? '已终止' : '完成'}`;
    try {
      router.emit('message', {
        from: owner ?? 'system',
        to: 'user',
        type: 'job.done',
        payload: summary,
        data: {
          agentId: owner,
          jobId: job.id,
          kind: job.kind,
          status: job.status,
          ...(job.detail !== undefined ? { detail: job.detail } : {}),
        },
      });
    } catch (err: any) {
      logger.warn(`[Bootstrap] 后台任务完成通知广播失败: ${err?.message ?? String(err)}`);
    }
    if (owner) {
      try {
        void router.followup(owner, {
          role: 'user',
          content: `[系统通知] ${summary}${job.detail !== undefined ? `：${job.detail}` : ''}。`,
          agent_id: owner,
          delivery: { maxSteps: 8 },
          source: { kind: 'system', form: 'notice', summary },
        } as AgentMessage, { target: 'user' });
      } catch (err: any) {
        logger.warn(`[Bootstrap] 后台任务完成通知进 inbox 失败: ${err?.message ?? String(err)}`);
      }
    }
  });

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

  // L1.5 模块热重载执行体（reload-requested scope='modules' 中断时经
  // createAgentContext 的 interruptHandler 调用；docs/restart-design.md §2.4）。
  // hmr 行为组合树可选服务：执行期惰性取；缺失/异常都收敛为失败报告
  // （回滚语义在重载机器内，旧树继续运行），不中断当前 run。
  assembly.reloadModules = async (files) => {
    const hmr = ctx.get('hmr') as {
      reloadFiles(urls: string[]): Promise<{ ok: boolean; reloaded: string[]; error?: string }>;
    } | undefined;
    if (!hmr) {
      return {
        ok: false, reloaded: [],
        message: 'HMR 服务不可用（需 Loader 组合路径 + --expose-internals 启用 hmr 行）',
      };
    }
    try {
      const result = await hmr.reloadFiles(files);
      if (result.ok) {
        logger.info(`[Reload] 模块热重载成功（${result.reloaded.length} 个插件入口：${result.reloaded.join('、') || '无'}）`);
        return { ok: true, reloaded: result.reloaded, message: '' };
      }
      logger.warn(`[Reload] 模块热重载失败（已回滚旧模块）: ${result.error}`);
      return { ok: false, reloaded: [], message: result.error ?? '未知错误' };
    } catch (err: any) {
      logger.warn(`[Reload] 模块热重载被拒绝: ${err?.message ?? String(err)}`);
      return { ok: false, reloaded: [], message: err?.message ?? String(err) };
    }
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
