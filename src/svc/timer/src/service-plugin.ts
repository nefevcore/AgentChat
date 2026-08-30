// ============================================================
// @agentchat/timer/src/service-plugin.ts —— TimerManager 宿主插件行（块 A）
//
// TimerManager 由本行构造并持有（boot 不再 new），并写回 boot 契约的
// PluginServices（ToolContext）共享实例；@agentchat/timer/src/plugin
// 只负责注册 timer 工具，两者共用同一 Manager（工具运行时读 services.timer）。
//
// inject: bootstrap, archive —— archive 提供 __archive_all__ 特殊 hint 回调；
// __backup_all__ 直接经 @agentchat/backup 的 createBackup 提供。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { createBackup } from '@agentchat/backup';
import type { ArchiveHostService } from '@agentchat/archive';
import type { PluginServices } from '@agentchat/tools';
import type { GlobalTimerConfig } from './timer';
import { TimerManager } from './timer';
import { TimerService } from './service';

export const name = 'agentchat-timer-service';
export const inject = ['bootstrap', 'archive'];

interface BootstrapRuntime {
  services: PluginServices;
  workspaceDir: string;
  agentsDir: string;
  globalConfig: Record<string, any>;
  router: { on(event: string, handler: (...args: any[]) => void): unknown };
}

export function apply(ctx: Context) {
  const core = ctx.bootstrap as BootstrapRuntime;
  const globalConfig = core.globalConfig;
  const agentTimerNs = (globalConfig.namespaces ?? {})['agent.timer'] as Record<string, unknown> | undefined;

  const manager = new TimerManager({
    workspaceDir: core.workspaceDir,
    agentsDir: core.agentsDir,
    timezone: (globalConfig.timezone as string | undefined) ?? 'Asia/Shanghai',
    holidays: agentTimerNs?.holidays as string[] | undefined,
    makeupWorkdays: agentTimerNs?.makeupWorkdays as string[] | undefined,
    globalTimer: (globalConfig.timer ?? globalConfig.chime) as GlobalTimerConfig,
    archiveAll: () => (ctx.archive as ArchiveHostService | undefined)?.manager.archiveAllActiveSessions() ?? { length: 0 },
    backupAll: () => {
      const r = createBackup();
      return { skipped: r.skipped ?? false, file: r.file, size: r.size };
    },
  });
  manager.setRouter(core.router as never);

  // 写共享 ToolContext：@agentchat/timer/src/plugin 注册的 timer 工具经 services.timer 取同一实例
  core.services.timer = manager;
  new TimerService(ctx, manager);

  ctx.logger('timer').info('TimerManager 由 timer 插件行持有（ctx.timerManager.manager）');
  return () => manager.dispose();
}
