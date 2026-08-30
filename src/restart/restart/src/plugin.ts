import type { Context } from '@agentchat/cordis';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import { registerRestartTools } from './register';
import { RESTART_SOURCE_TAG } from './source-tag';

export const name = 'agentchat-restart-tools';
export const inject = ['tools', 'hooks'];

export function apply(ctx: Context) {
  registerRestartTools(ctx.tools, name);
  ctx.hooks.register('stepStart', 'restart.source-tag', () => makeSourceTagStepStartHook(RESTART_SOURCE_TAG), undefined, true);
  ctx.hooks.register('runStart', 'restart.source-contract', () => makeSourceContractRunStartHook(RESTART_SOURCE_TAG), undefined, true);
}
