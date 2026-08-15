// ============================================================
// @agentchat/plugins/src/plugin.ts —— ctx.pluginHost 服务行
//
// 与 cordis.yml 的服务行同构：在任何动态插件装载之前提供 ctx.pluginHost，
// 保证 boot 启动扫描 / dev 插件工具 / HTTP 层共用同一个 PluginHost 实例。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { getOrCreatePluginHost } from './host';

export const name = 'agentchat-plugin-host';

export function apply(ctx: Context) {
  getOrCreatePluginHost(ctx);
  ctx.logger('plugins').info('ctx.pluginHost 就绪（动态插件装载器服务行）');
}
