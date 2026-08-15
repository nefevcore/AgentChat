// ============================================================
// @agentchat/agent-skill/src/plugin.ts —— 技能注入插件行
//
// 注册 discovered_skills 钩子进 ctx.hooks。
// 由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerSkillHooks } from './register';

export const name = 'agentchat-agent-skill';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerSkillHooks(ctx.hooks, name);
}
