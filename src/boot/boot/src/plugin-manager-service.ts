// ============================================================
// @agentchat/boot/src/plugin-manager-service.ts —— ctx.pluginManager Service
//
// boot-finalize 构造 PluginManager 后注册为 cordis Service；
// 插件域 /api/plugins 路由行 inject ['pluginManager']，由服务依赖
// 保证路由只会在 PluginManager 就绪后挂载（不会"迟到即永久缺路由"）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import type { PluginManager } from '@agentchat/server';

export class PluginManagerService extends Service {
  readonly manager: PluginManager;

  constructor(ctx: Context, manager: PluginManager) {
    super(ctx, 'pluginManager');
    this.manager = manager;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 插件管理适配器（boot-finalize 提供；/api/plugins 路由行 inject） */
    pluginManager: PluginManagerService;
  }
}
