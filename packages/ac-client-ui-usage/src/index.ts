// ============================================================
// ac-client-ui-usage —— usage 域前端行（M28 P1 §4.1 原案）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-usage 后端行完全
// 解耦（唯一联系 = usage/tokens RPC 契约面；双向可独立摘除）。宿主
// apply 极薄——仅向 ac-webui 声明 boot graph 条目。
//
// 可摘除性（双向语义）：
//   · 卸本行 → aux 选区与 overlay 意图宿主消失（rail 图标随选区注册
//     回收；uiStore.openTokenUsage 意图无消费者，静默）；
//   · 卸后端行（ac-usage）→ 本行照常装载，RPC 失败 → 面板空态降级。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-usage';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-usage',
  label: '用量（前端）',
  description: 'usage 域前端行（M28 P1）：Token 用量面板（aux 选区 + overlay 意图宿主——柱状图/弦图/汇总）+ usageApi 数据面；与 ac-usage 后端行双向可独立摘除',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收）
  const off = ctx.webui.declareClient({
    name: 'ui-usage',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
