// ============================================================
// @agentchat/agent-session/src/plugin.ts —— 会话钩子插件行
//
// 注册 load-history/save-session/idle-reset/archive-session/log-usage
// 钩子进 ctx.hooks。由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerSessionHooks } from './register';

export const name = 'agentchat-agent-session';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerSessionHooks(ctx.hooks, name);
}
