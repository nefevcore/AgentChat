// ============================================================
// @agentchat/subagent/src/plugin.ts —— subagent 工具插件（cordis 嵌套插件）
//
// 由 boot 插件 ctx.plugin() 挂载（或 cordis.yml 独立行，inject: ['tools']）。
// 另注册本域来源标签钩子（ownerless automatic，装载本行即生效）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import { registerSubagentTool } from './register';
import { SUBAGENT_SOURCE_TAG } from './source-tag';

export const name = 'agentchat-subagent-tools';
export const inject = ['tools', 'hooks'];

export function apply(ctx: Context) {
  registerSubagentTool(ctx.tools, name);
  ctx.hooks.register('stepStart', 'subagent.source-tag', () => makeSourceTagStepStartHook(SUBAGENT_SOURCE_TAG), undefined, true);
  ctx.hooks.register('runStart', 'subagent.source-contract', () => makeSourceContractRunStartHook(SUBAGENT_SOURCE_TAG), undefined, true);
}