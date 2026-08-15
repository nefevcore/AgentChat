// ============================================================
// @agentchat/subagent/src/plugin.ts —— subagent 工具插件（cordis 嵌套插件）
//
// 由 boot 插件 ctx.plugin() 挂载（或 cordis.yml 独立行，inject: ['tools']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerSubagentTool } from './register';

export const name = 'agentchat-subagent-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  registerSubagentTool(ctx.tools, name);
}
