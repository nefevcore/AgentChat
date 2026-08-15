// ============================================================
// @agentchat/webui —— WebUI cordis 插件（DSH 风格三段式）
//
//   · 服务端挂载：本插件自带前端 dist，应用运行时托管 SPA；
//   · 生命周期：boot 提供 ctx.webServerHost（ServiceRegistry + 工作区 +
//     端口）后，本插件 inject webServerHost 自行启动 HTTP/WS；
//   · 插件 UI 资源仍由 @agentchat/plugins 的 ctx.webui 挂到 /ui-plugin/*。
// ============================================================
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ServerService, WebUIServer } from '@agentchat/server';
import type { WebUIServerOptions } from '@agentchat/server';
import type { WebServerHostService } from '@agentchat/server';
import type { Context } from '@agentchat/cordis';

/** 插件自带的前端构建产物目录（preview/packages/ui/webui/dist） */
export function webuiDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
}

/** 由 boot 注入的宿主服务（webServerHost）最小面 */
export interface WebServerHostLike {
  serviceRegistry: WebUIServerOptions['serviceRegistry'];
  dataDir: string;
  port: number;
  /** 可选：插件域事件总线（boot 核心行提供，WebUI 广播 plugin.* 事件用） */
  pluginEvents?: import('@agentchat/server').PluginEventBus;
}

/**
 * 创建并启动 WebUIServer；同时把 ctx.server 包装为 cordis Service。
 * 静态资源固定使用本插件内置 dist，不再依赖 preview 外部的 src/ui/webui/dist。
 */
export async function startWebUIServer(
  ctx: Context,
  host: WebServerHostLike,
  port: number = host.port,
): Promise<WebUIServer> {
  const server = new WebUIServer({
    serviceRegistry: host.serviceRegistry,
    dataDir: host.dataDir,
    port,
    ctx,
    staticDir: webuiDistDir(),
    pluginEvents: host.pluginEvents,
    routeRegistry: ctx.http,
  });
  await server.start();
  new ServerService(ctx, server);
  return server;
}

export type { WebServerHostService };
/** cordis 插件行（boot 直接调用路径用；Loader 路径仍从 cordis.yml 加载） */
export * as webuiPlugin from './plugin';
