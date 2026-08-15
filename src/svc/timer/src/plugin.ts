// ============================================================
// @agentchat/timer/src/plugin.ts —— timer 工具插件（cordis 嵌套插件）
//
// 由 boot 插件 ctx.plugin() 挂载（或 cordis.yml 独立行，inject: ['tools']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerTimerTool } from './register';

export const name = 'agentchat-timer-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerTimerTool(ctx.tools, name);
}
