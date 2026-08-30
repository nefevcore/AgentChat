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
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import type { SourceTagContract } from '@agentchat/contracts';
import type { PluginServices } from '@agentchat/tools';
import { ArchiveService } from './index';

export const name = 'agentchat-archive-service';
export const inject = ['bootstrap', 'hooks'];

/** 归档整理来源标签（kind='archive'）：记忆归档 run 的入站形态 */
const ARCHIVE_SOURCE_TAG: SourceTagContract = {
  kind: 'archive',
  tag: () => '[归档整理]',
  contractSection: [
    '## 消息来源：归档整理',
    '- user 消息正文首行的 `[归档整理]` 标签表示记忆归档整理任务触发：按记忆管理规则整理。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};

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
  // 经 any 取 bootstrap：本文件的程序上下文（如 webui tsconfig.plugin.json 传递包含）
  // 可能不含 boot 包的 Context 模块扩充，直接属性访问会 TS2339；inject 已保证运行时存在。
  const core = (ctx as any).bootstrap as BootstrapRuntime;
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
  // 归档域来源标签钩子（ownerless automatic，装载本行即生效）
  ctx.hooks.register('stepStart', 'archive.source-tag', () => makeSourceTagStepStartHook(ARCHIVE_SOURCE_TAG), undefined, true);
  ctx.hooks.register('runStart', 'archive.source-contract', () => makeSourceContractRunStartHook(ARCHIVE_SOURCE_TAG), undefined, true);
  return () => archiveService.dispose();
}
