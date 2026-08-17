import type { HooksService } from '@agentchat/hooks';
import { logRunUsage } from './session';
import {
  makeLoadHistoryHook, makeRecoverHistoryHook, makeIdleResetHook, makeArchiveSessionHook,
  makeGroupContractHook,
} from './run';
import { makeSaveSessionHook, makeStepPersistHook, makeToolPersistHook } from './writer';

/** 注册 agent-session 扩展钩子（load-history + step 持久化 + 会话收尾；owner = cordis 插件 name） */
export function registerSessionHooks(hooks: HooksService, owner: string): void {
  hooks.register('runStart', 'agent-session.load-history', (config, s) => makeLoadHistoryHook(config, s), owner);
  // 基础设施钩子（automatic）：不依赖 config.hooks 清单，step 级增量落盘 + 恢复调和 + checkpoint
  hooks.register('runStart', 'agent-session.recover-history', (config, s) => makeRecoverHistoryHook(config, s), owner, true);
  // 群聊行为契约注入（automatic，注册序在 load-history 之后 → 契约位于已加载历史尾部；
  // 单通道化 v3：契约从 router hint 文案机制化，重构不可无声丢弃——I11 快照锚定）
  hooks.register('runStart', 'agent-session.group-contract', (config) => makeGroupContractHook(config), owner, true);
  hooks.register('stepEnd', 'agent-session.step-persist', (config) => makeStepPersistHook(config), owner, true);
  hooks.register('toolExecutionStart', 'agent-session.tool-persist', (config) => makeToolPersistHook(config), owner, true);
  hooks.register('runEnd', 'agent-session.save-session', (config) => makeSaveSessionHook(config), owner, true);
  hooks.register('runEnd', 'agent-session.idle-reset', (config, s) => makeIdleResetHook(config, s), owner);
  hooks.register('runEnd', 'agent-session.archive-session', (config, s) => makeArchiveSessionHook(config, s), owner);
  hooks.register('runEnd', 'agent-session.log-usage', () => logRunUsage, owner);
}
