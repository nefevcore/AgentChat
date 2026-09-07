// ============================================================
// ac-client-ui-runview —— runview 前端行（M27 S3 首例，D19/D12；
// M27.1 改名入 ac-client-ui-* 全族——派生名 ui-runview 三处同名）
//
// 运行矩阵域【无后端能力】：本行的 payload 就是 client 半边（运行矩阵
// 的 ctx.runs 域投影）。宿主 apply 极薄——不注册任何服务，仅向
// ac-webui 声明 boot graph 条目（前端装配序列第④步按图装载 client
// 模块）。
//
// 可摘除性（D19 语义）：卸载本行 = boot graph 收缩条目 → 前端运行矩阵
// 消费面一并消失（RunTracking/RunTrackingPanel 空态），宿主不残废。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-runview';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-runview',
  label: '运行矩阵（前端）',
  description: 'runview 前端行：运行矩阵域投影（ctx.runs）——boot graph 条目声明 + client 半边装载',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-runview',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
