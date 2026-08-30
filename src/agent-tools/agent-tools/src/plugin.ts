// ============================================================
// @agentchat/agent-tools/src/plugin.ts —— 协作工具插件行
//
// 注册多 Agent 协作工具（send_agent/send_group/list_agents 等）进 ctx.tools。
// 另注册本域来源标签钩子（ownerless automatic，装载本行即生效）。
// 由 cordis.yml 挂载（inject: ['tools']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { makeSourceTagStepStartHook, makeSourceContractRunStartHook } from '@agentchat/contracts';
import { registerAgentTools } from './register';
import { AGENT_SOURCE_TAG, GROUP_SOURCE_TAG } from './source-tag';

export const name = 'agentchat-agent-tools';
export const inject = ['tools', 'hooks'];

export function apply(ctx: Context) {
  registerAgentTools(ctx.tools, name);
  // 协作域两种来源形态各注册一组钩子（agent 间消息 + 群聊消息）
  ctx.hooks.register('stepStart', 'agent-tools.agent-source-tag', () => makeSourceTagStepStartHook(AGENT_SOURCE_TAG), undefined, true);
  ctx.hooks.register('runStart', 'agent-tools.agent-source-contract', () => makeSourceContractRunStartHook(AGENT_SOURCE_TAG), undefined, true);
  ctx.hooks.register('stepStart', 'agent-tools.group-source-tag', () => makeSourceTagStepStartHook(GROUP_SOURCE_TAG), undefined, true);
  ctx.hooks.register('runStart', 'agent-tools.group-source-contract', () => makeSourceContractRunStartHook(GROUP_SOURCE_TAG), undefined, true);
}
