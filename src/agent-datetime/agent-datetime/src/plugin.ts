// ============================================================
// @agentchat/agent-datetime/src/plugin.ts —— 日期注入插件行
//
// 注册 datetime 钩子进 ctx.hooks（清单钩子：config.hooks 显式
// 列出才启用）。由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerDatetimeHooks } from './register';

export const name = 'agentchat-agent-datetime';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerDatetimeHooks(ctx.hooks, name);
}
