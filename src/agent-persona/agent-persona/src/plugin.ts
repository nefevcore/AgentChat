// ============================================================
// @agentchat/agent-persona/src/plugin.ts —— 人设注入插件行
//
// 注册 persona 钩子进 ctx.hooks。
// 由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerPersonaHooks } from './register';

export const name = 'agentchat-agent-persona';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerPersonaHooks(ctx.hooks, name);
}
