// ============================================================
// @agentchat/archive/src/plugin.ts —— 归档编排服务插件行（块 A）
//
// ArchiveService 由本行构造并持有（不再由 boot new），
// 同时把 runEnd 归档入口 / idle-reset 入口写入 boot 契约的
// PluginServices（ToolContext）共享实例。
//
// inject: bootstrap —— boot 核心契约（router/registry/workspaceDir/agentsDir）
// 注意：此处只依赖契约结构，不 import @agentchat/boot，避免 server→archive→boot 静态环。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { counterpartOfDialog } from '@agentchat/agents';
import type { PluginServices } from '@agentchat/tools';
import { ArchiveService } from './index';

export const name = 'agentchat-archive-service';
export const inject = ['bootstrap'];

/** boot 核心契约的运行面（ArchiveService 只用 router.trigger/emit + registry） */
interface BootstrapRuntime {
  services: PluginServices;
  workspaceDir: string;
  agentsDir: string;
  router: {
    trigger(...args: any[]): Promise<string>;
    emit(event: string, data: unknown): void;
  };
  registry: {
    get(id: string): unknown;
    isVirtual(id: string): boolean;
  };
}

/** ctx.archive —— 归档编排服务（boot-finalize 消费并启动 watcher） */
export class ArchiveHostService extends Service {
  readonly manager: ArchiveService;

  constructor(ctx: Context, manager: ArchiveService) {
    super(ctx, 'archive');
    this.manager = manager;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 归档编排管理器（@agentchat/archive 插件行提供） */
    archive: ArchiveHostService;
  }
}

export function apply(ctx: Context) {
  const core = ctx.bootstrap as BootstrapRuntime;
  const archiveService = new ArchiveService({
    wsRoot: core.workspaceDir,
    agentsDir: core.agentsDir,
    router: core.router as never,
    registry: core.registry as never,
  });

  // 写共享 ToolContext：runEnd archive-session 钩子与 idle-reset 钩子读取
  core.services.archiveSession = (runCtx, result) => archiveService.handleRunEnd(runCtx, result);
  core.services.idleReset = (dialogId, selfId) => {
    if (!selfId) return;
    try {
      const counterpart = counterpartOfDialog(dialogId, selfId);
      if (!counterpart || counterpart === '?') return;
      archiveService.resetIdleTimer(selfId, counterpart);
    } catch { /* ignore */ }
  };

  new ArchiveHostService(ctx, archiveService);
  return () => archiveService.dispose();
}
