// ============================================================
// ac-client-ui-renderer —— renderer 基础件前端行（M27.2-2 出包之二）
//
// 基础七件之一（phase:'base'——封印前批次装载）：Vue 渲染地基。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第③步 base 阶段按图装载 client 模块）。
//
// client 半边资产（ownership §3.2 落点）：
//   · ctx.vueRenderer 服务（boot-once install + renderSlot）；
//   · SlotOutlet/SlotOutletItem/slotRender 席位渲染资产；
//   · markdown 管线（useMarkdown + abap-hljs + logger）；
//   · ScrollableViewport 气泡通用渲染资产。
//
// 可摘除性：本件是渲染地基（install boot-once）——卸载即 boot graph
// base 行集变更 → 前端整页重载（M27.2 §3.2 裁决）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-renderer';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-renderer',
  label: '渲染器（前端）',
  description: 'renderer 基础件前端行：Vue 渲染地基（ctx.vueRenderer boot-once 安装 + SlotOutlet/席位渲染资产 + markdown 管线；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-renderer',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
