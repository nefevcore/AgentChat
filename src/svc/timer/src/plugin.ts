// ============================================================
// @agentchat/timer/src/plugin.ts —— timer 工具插件（cordis 嵌套插件）
//
// 由 boot 插件 ctx.plugin() 挂载（或 cordis.yml 独立行，inject: ['tools']）。
// 另注册本域来源标签钩子（ownerless automatic：不受 hooks 清单与
// preset 过滤，装载本行即生效；停用本行即移除）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import { registerTimerTool } from './register';
import { TIMER_SOURCE_TAG } from './source-tag';

export const name = 'agentchat-timer-tools';
export const inject = ['tools', 'hooks'];

export function apply(ctx: Context) {
  registerTimerTool(ctx.tools, name);
  ctx.hooks.register('stepStart', 'timer.source-tag', () => makeSourceTagStepStartHook(TIMER_SOURCE_TAG), undefined, true);
  ctx.hooks.register('runStart', 'timer.source-contract', () => makeSourceContractRunStartHook(TIMER_SOURCE_TAG), undefined, true);
}
