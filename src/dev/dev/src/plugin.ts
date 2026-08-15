import type { Context } from '@agentchat/cordis';
import { getOrCreatePluginHost } from '@agentchat/plugins';
import { registerDevTools } from './register';

export const name = 'agentchat-dev-tools';
export const inject = ['tools'];

export function apply(ctx: Context) {
  // 复用 ctx.pluginHost（plugins 服务行先挂载）；无该服务时兜底创建（测试/手动装配）
  const host = getOrCreatePluginHost(ctx);
  registerDevTools(ctx.tools, name, host);
}
