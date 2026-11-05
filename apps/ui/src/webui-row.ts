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
import { readdirSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import type { Plugin, Context } from '@agentchat/cordis';
import { assembleBootGraph, resolveUiAsset, synthesizeWebuiGraph } from 'ac-webui-core';
// webServer 契约增强（declare module 全局合并靠 include src 面闭合——本 tsconfig 已含）
import type {} from 'ac-web-server';

/** 插件目录签名（父目录 mtime + 各子目录 mtime 排序串）——任一变化 = 重扫 */
function dirSignature(pluginsDir: string, profileDir: string): string | null {
  const self = statSync(pluginsDir, { throwIfNoEntry: false });
  if (!self) return null;
  const parts: string[] = [String(self.mtimeMs)];
  // webui 装配文档签名（cr-905 批3：分层文档变化 = graph 变化——基座/
  // custom/installed 任一 mtime 进签名，文档编辑后缓存即失效）
  for (const doc of ['webui.patch.yml', 'webui-custom.patch.yml', 'installed.patch.yml']) {
    const st = statSync(joinPath(profileDir, doc), { throwIfNoEntry: false });
    parts.push(doc + ':' + (st ? st.mtimeMs : 'x'));
  }
  try {
    for (const ent of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const st = statSync(`${pluginsDir}/${ent.name}`, { throwIfNoEntry: false });
      parts.push(ent.name + ':' + (st ? st.mtimeMs : 'x'));
    }
  } catch { /* 读失败 = 空图语义（assembleBootGraph 同容错） */ }
  return parts.sort().join('|');
}

export interface WebuiRowOptions {
  /** 插件目录（manifest 扫描根 = graph 与静态资产同源目录） */
  pluginsDir: string;
  /** webui 装配文档目录（<dataRoot>/profile——分层合成输入；缺省 = pluginsDir 同级 profile） */
  profileDir?: string;
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

      // boot graph（通道条目清单——manifest 扫描单源；坏 manifest fail-loud 记 warning）。
      // mtime 缓存（cr-843）：父目录 mtime 覆盖子目录增删（安装/卸载），各子目录
      // mtime 覆盖内容替换（cr-893：build-channel 重建产物不改父目录 mtime，
      // 只看父目录时 version bump 永不进 graph——旧图常驻）。stat×N 远低于
      // 此前每次请求 30×readdir+readFile+JSON.parse 的扫描成本。
      const profileDir = options.profileDir ?? resolvePath(options.pluginsDir, '../profile');
      let cachedGraph: { sig: string | null; body: string } | null = null;
      web.route('GET', '/api/ui/boot-graph', (call) => {
        const dirSig = dirSignature(options.pluginsDir, profileDir);
        if (cachedGraph?.sig !== dirSig) {
          // 分层合成（cr-905 批3：基座 − custom disabled ∪ installed(scope:webui)，
          // 目录扫描对账——文档点名而物化缺席 = 警告 + 跳过）
          const { graph, warnings } = synthesizeWebuiGraph(options.pluginsDir, profileDir);
          if (warnings.length > 0) console.warn('[webui] boot graph 分层警告：', warnings.join('；'));
          cachedGraph = { sig: dirSig, body: JSON.stringify({ clients: graph, warnings }) };
        }
        call.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        call.res.end(cachedGraph.body);
      });

      // 通道静态资产（/ui-plugin/<name>/<rel> → pluginsDir/<name>/<rel>；逃逸/缺失 → 404）。
      // 应答走 webServer.serveFileRoute（cr-843）：br/gzip 压缩 + ETag 协商 +
      // content-length——此前裸传原始字节且无缓存头，浏览器刷新全量回源
      //（108 JS 3.4MB + 27 CSS 1.7MB），偶发刷新慢的主因。通道产物非内容
      // 哈希文件名 → no-cache + 304 协商（字节不变免传，重建后 etag 变化即重拉）。
      web.route('GET', '/ui-plugin/:name/*', async (call) => {
        const asset = resolveUiAsset(options.pluginsDir, call.params.name, call.params['*']);
        if (asset === null) {
          call.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          call.res.end('not found');
          return;
        }
        await ctx.webServer.serveFileRoute(call.res, asset.file, {
          acceptEncoding: call.req.headers['accept-encoding'] ?? '',
        });
      });
    },
  };
}
