import type { HooksService } from '@agentchat/hooks';
import { saveSession, logRunUsage } from './session';
import { makeLoadHistoryHook, makeIdleResetHook, makeArchiveSessionHook } from './run';

/** 注册 agent-session 扩展钩子（load-history + 会话收尾；owner = cordis 插件 name） */
export function registerSessionHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-session.load-history', (config, s) => makeLoadHistoryHook(config, s), owner);
  hooks.register('runEnd', 'agent-session.save-session', () => saveSession, owner);
  hooks.register('runEnd', 'agent-session.idle-reset', (config, s) => makeIdleResetHook(config, s), owner);
  hooks.register('runEnd', 'agent-session.archive-session', (config, s) => makeArchiveSessionHook(config, s), owner);
  hooks.register('runEnd', 'agent-session.log-usage', () => logRunUsage, owner);
}
