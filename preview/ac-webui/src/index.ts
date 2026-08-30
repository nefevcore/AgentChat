// ============================================================
// ac-webui —— Web UI 表面行（ctx.webui）
//
// inject ['webServer']：注册两条 HTTP 路由（注册即归属——本行摘除
// 即下线，webui 服务面与传输面解耦）：
//   GET /api/ui/extensions   扩展清单（前端宿主拉取）
//   GET /ui-plugin/:name/*   插件 UI 产物静态服务（安全路径）
//
// 契约出口固定形态：webui/extensions-changed(E) 随本包走。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { WebUiService } from './service.ts';

export const name = 'ac-webui';

export const inject = ['webServer'];

export function apply(ctx: Context) {
  // 直构（非 ctx.plugin）：行 apply 闭包要访问本行自身提供的 webui 服务
  // （自依赖 inject 禁止）；webServer 为外部依赖经 inject 声明
  const webui = new WebUiService(ctx);

  ctx.webServer.route('GET', '/api/ui/extensions', (call) => {
    call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    call.res.end(JSON.stringify({ extensions: webui.listExtensions() }));
  });

  ctx.webServer.route('GET', '/ui-plugin/:name/*', async (call) => {
    await webui.serveUiAsset(call.params.name, call.params['*'], (status, body, type) => {
      call.res.writeHead(status, { 'content-type': type });
      call.res.end(body);
    });
  });
}

export { WebUiService } from './service.ts';
export type { PluginUiManifest, UiExtensionDescriptor } from './service.ts';
