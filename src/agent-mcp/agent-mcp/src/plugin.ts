// ============================================================
// @agentchat/agent-mcp/src/plugin.ts —— MCP 钩子插件行
//
// 注册 open-mcp 钩子进 ctx.hooks。由 cordis.yml 挂载（inject: ['hooks']）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerMcpHooks } from './register';

export const name = 'agentchat-agent-mcp';
export const inject = ['hooks'];

export function apply(ctx: Context) {
  registerMcpHooks(ctx.hooks, name);
}
