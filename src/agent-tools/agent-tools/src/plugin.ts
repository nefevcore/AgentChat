// ============================================================
// @agentchat/agent-tools/src/plugin.ts —— 协作工具插件行
//
// 注册多 Agent 协作工具（send_agent/send_group/list_agents 等）进 ctx.tools。
// 由 cordis.yml 挂载（inject: ['tools']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerAgentTools } from './register';

export const name = 'agentchat-agent-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerAgentTools(ctx.tools, name);
}
