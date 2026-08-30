// ============================================================
// @agentchat/shell/src/plugin.ts —— shell 插件行（bash + job）
// inject: tools（工具注册中心）+ jobs（通用后台任务注册表，background/job 工具消费）
// ============================================================
import type { Context } from '@agentchat/cordis';
import { registerShellTools } from './register';

export const name = 'agentchat-shell-tools';
export const inject = ['tools', 'jobs'];

export function apply(ctx: Context) {
  registerShellTools(ctx.tools, name, ctx.jobs);
}
