// ============================================================
// @agentchat/agent-prompt/src/plugin.ts —— 提示词钩子插件行
//
// 注册 build-system-prompt + discovered_skills 钩子进 ctx.hooks。
// 由 cordis.yml 挂载（inject: ['hooks']）；registerCoreServices 兜底同构挂载。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerPromptHooks } from './register';

export const name = 'agentchat-agent-prompt';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerPromptHooks(ctx.hooks, name);
}
