// ============================================================
// @agentchat/webui/src/plugin.ts —— cordis.yml 插件行
//
// inject: webServerHost, http —— 等 boot 把 ServiceRegistry/工作区/端口
// 与 HTTP 路由注册表准备好后，本行自行创建 WebUIServer（HTTP + WS +
// SPA 托管）并注册 ctx.server。
//
// L3：/api/ui + /ui-plugin 由本行注册到 ctx.http（挂/摘本行 = 挂/摘 UI 路由）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { WebServerHostService, PluginEventBus, WebUIServer } from '@agentchat/server';
import { createUiRouter, createUiPluginStaticHandler } from '@agentchat/server';
import { startWebUIServer } from './index';

export const name = 'agentchat-webui';
export const inject = ['webServerHost', 'http'];

export interface Config {
  /** 覆盖 webServerHost 的端口（默认 3830） */
  webuiPort?: number;
}

export async function apply(ctx: Context, config: Config = {}) {
  const host = ctx.webServerHost as WebServerHostService | undefined;
  if (!host || !host.enabled) return;
  const port = config.webuiPort ?? host.port;

  // L3：UI 域路由先注册（WebUIServer 只 mount ctx.http.middleware）
  const disposeUiApi = ctx.http.register('/api/ui', createUiRouter(ctx));
  const disposeUiStatic = ctx.http.registerStatic('/ui-plugin', createUiPluginStaticHandler(ctx));

  // 可选：boot 核心行的插件域事件总线（PluginEventBus → WSHandler 广播）
  const bootstrap = ctx.get?.('bootstrap') as { pluginEvents?: PluginEventBus } | undefined;
  let server: WebUIServer;
  try {
    server = await startWebUIServer(ctx, {
      serviceRegistry: host.serviceRegistry,
      dataDir: host.dataDir,
      port,
      pluginEvents: bootstrap?.pluginEvents,
    }, port);
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      ctx.logger('webui').error(`端口 ${port} 已被占用：已有 AgentChat 实例在运行。为避免重复定时调度/重复写状态，本进程立即退出。`);
      process.exit(1);
    }
    throw err;
  }
  ctx.logger('webui').info(`WebUI 插件行已启动：http://localhost:${port}（/api/ui + /ui-plugin 已注册）`);
  return () => {
    disposeUiApi();
    disposeUiStatic();
    void server.stop();
  };
}
