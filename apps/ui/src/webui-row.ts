// ============================================================
// webui-row.ts —— webui 本体服务半边（8.5b；主线 ac-webui 行的 preview 改造形态）
//
// 与主线行的差异（终态定向，ui-tree.md §3-4 + 裁决簿〈骨架归并〉〈插件 client 通道〉）：
//   · boot graph 单源化：主线 = declareClient 注册表（行 apply 声明——骨架六包
//     桩行的通道）；终态 = manifest 数据声明（R7-9：第一方与第三方同走唯一
//     通道，零特权路径）。本行 graph = <dataRoot>/plugins/ 目录扫描
//     （ac-webui-core assembleBootGraph——M7.4 纯函数接线）；
//   · 静态面单源化：主线 = addEntry 注册表 dir；本行 = pluginsDir/<name> 直读
//     （resolveUiAsset——同一目录，graph 与资产同源）；
//   · declareClient/extensions 注册表面不承接（消费方 plugin-registry 归 8.8
//     装配面；extensions 清单与 graph 在 manifest 通道下同源合一）。
// phase:'base' 随骨架归并退役——骨架 3 件 in-bundle（client/ 装配序列），
// 本端点只发通道条目（模块资产），单一动态语义。
// ============================================================
import { readFile } from 'node:fs/promises';
import type { Plugin, Context } from '@agentchat/cordis';
import { assembleBootGraph, resolveUiAsset } from 'ac-webui-core';
// webServer 契约增强（declare module 全局合并靠 include src 面闭合——本 tsconfig 已含）
import type {} from 'ac-web-server';

export interface WebuiRowOptions {
  /** 插件目录（manifest 扫描根 = graph 与静态资产同源目录） */
  pluginsDir: string;
}

/**
 * webui 本体行（Plugin 形态——宿主 boot ctx.plugin 装配；inject ['webServer']）。
 * 路由注册即归属：本行摘除即端点下线。
 */
export function makeWebuiRow(options: WebuiRowOptions): Plugin {
  return {
    name: 'ac-ui-app/webui',
    inject: ['webServer'],
    apply(ctx: Context) {
      const web = ctx.webServer;

      // boot graph（通道条目清单——manifest 扫描单源；坏 manifest fail-loud 记 warning）
      web.route('GET', '/api/ui/boot-graph', (call) => {
        const { graph, warnings } = assembleBootGraph(options.pluginsDir);
        if (warnings.length > 0) console.warn('[webui] boot graph 扫描警告：', warnings.join('；'));
        call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(JSON.stringify({ clients: graph }));
      });

      // 通道静态资产（/ui-plugin/<name>/<rel> → pluginsDir/<name>/<rel>；逃逸/缺失 → 404/403）
      web.route('GET', '/ui-plugin/:name/*', async (call) => {
        const asset = resolveUiAsset(options.pluginsDir, call.params.name, call.params['*']);
        if (asset === null) {
          call.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          call.res.end('not found');
          return;
        }
        const buf = await readFile(asset.file);
        call.res.writeHead(200, { 'content-type': asset.contentType });
        call.res.end(buf);
      });
    },
  };
}
