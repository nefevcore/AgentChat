// ============================================================
// @agentchat/agent-memory/src/plugin.ts —— 记忆钩子插件行
//
// 注册 load-memory 钩子进 ctx.hooks。由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerMemoryHooks } from './register';

export const name = 'agentchat-agent-memory';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerMemoryHooks(ctx.hooks, name);
}
