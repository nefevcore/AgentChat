// ============================================================
// ac-webui —— Web UI 表面行（ctx.webui）
//
// inject ['webServer']：注册三条 HTTP 路由（注册即归属——本行摘除
// 即下线，webui 服务面与传输面解耦）：
//   GET /api/ui/extensions   扩展清单（前端宿主拉取）
//   GET /api/ui/boot-graph   行 client 半边装载图
//   GET /ui-plugin/:name/*   插件 UI 产物静态服务（安全路径）
//
// 契约出口固定形态：webui/extensions-changed(E) / webui/boot-graph-changed(E)
// 随本包走（前者由 ac-plugin-registry 装载/卸载路径 emit）。远程 WebView
// 经 ac-remote-link 的通用 HTTP 转发桥（M3.4）到达全部 /api/* 端点。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { WebUiService } from './service.ts';

export const name = 'ac-webui';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'webui',
  label: 'WebUI 表面',
  description: 'Web UI 表面行（ctx.webui）：扩展清单 + boot graph 下发 + 插件 UI 静态托管',
  automatic: true,
};

export const inject = ['webServer'];

export function apply(ctx: Context) {
  // 直构（非 ctx.plugin）：行 apply 闭包要访问本行自身提供的 webui 服务
  // （自依赖 inject 禁止）；webServer 为外部依赖经 inject 声明
  const webui = new WebUiService(ctx);

  ctx.webServer.route('GET', '/api/ui/extensions', (call) => {
    call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    call.res.end(JSON.stringify({ extensions: webui.listExtensions() }));
  });

  // Boot graph 清单（M27 S3/D7：行 client 半边装载图——前端装配序列第④步拉取）
  ctx.webServer.route('GET', '/api/ui/boot-graph', (call) => {
    call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    call.res.end(JSON.stringify({ clients: webui.listBootGraph() }));
  });

  ctx.webServer.route('GET', '/ui-plugin/:name/*', async (call) => {
    await webui.serveUiAsset(call.params.name, call.params['*'], (status, body, type) => {
      call.res.writeHead(status, { 'content-type': type });
      call.res.end(body);
    });
  });
}

export { WebUiService } from './service.ts';
export type { UiExtensionDescriptor, RowClientDescriptor } from './service.ts';
// PluginUiManifest 单源住 ac-plugin-core（manifest owning 域），本包经 service.ts re-export
