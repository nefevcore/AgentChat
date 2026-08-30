// ============================================================
// @agentchat/subagent/src/service-plugin.ts —— SubAgentManager 宿主插件行（块 A）
//
// SubAgentManager 由本行构造并持有（boot 不再 new），写回 boot 契约的
// PluginServices（ToolContext）共享实例；@agentchat/subagent/src/plugin
// 只负责注册 subagent 工具，两者共用同一 Manager。
//
// inject: bootstrap, agentLoop, jobs —— 引擎由 agent-loop 插件行提供，
// 后台任务注册表由 @agentchat/jobs 提供（spawn 登记 kind=subagent）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { AgentLoopEngine } from '@agentchat/agent-loop';
import type { PluginServices } from '@agentchat/tools';
import { SubAgentManager } from './subagent';
import { SubAgentService } from './service';

export const name = 'agentchat-subagent-service';
export const inject = ['bootstrap', 'agentLoop', 'jobs'];

interface BootstrapRuntime {
  services: PluginServices;
  router: { on(event: string, handler: (...args: any[]) => void): unknown };
}

export function apply(ctx: Context) {
  const core = ctx.bootstrap as BootstrapRuntime;
  const manager = new SubAgentManager(ctx.agentLoop as AgentLoopEngine);
  manager.setEventBus(core.router as never);
  manager.setJobs(ctx.jobs);

  // 写共享 ToolContext：subagent 工具经 services.subAgent 取同一实例
  core.services.subAgent = manager;
  new SubAgentService(ctx, manager);

  ctx.logger('subagent').info('SubAgentManager 由 subagent 插件行持有（ctx.subagent.manager；已接入 ctx.jobs）');
}
