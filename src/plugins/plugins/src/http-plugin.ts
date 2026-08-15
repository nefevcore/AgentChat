// ============================================================
// @agentchat/plugins/src/http-plugin.ts —— /api/plugins 路由插件行（L3）
//
// PluginManager 由 boot-finalize 注册为 ctx.pluginManager Service；
// 本行 inject ['http','pluginManager']，服务依赖保证路由只会在
// PluginManager 就绪后挂载。挂/摘本行 = 挂/摘 /api/plugins。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { createPluginsRouter } from '@agentchat/server/src/api/plugins';
import type { PluginManager } from '@agentchat/server/src/api/plugins';

export const name = 'agentchat-plugin-http-routes';
export const inject = ['http', 'pluginManager'];

export function apply(ctx: Context) {
  const manager = ctx.pluginManager.manager as PluginManager;
  const dispose = ctx.http.register('/api/plugins', createPluginsRouter(manager));
  ctx.logger('plugins').info('/api/plugins 由插件域路由行注册');
  return dispose;
}
