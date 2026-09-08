// ============================================================
// ac-client-ui-goal —— goal 域前端行（M28 P1 §4.1 原案）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-goal 后端行完全
// 解耦（唯一联系 = goal/get RPC 契约面；双向可独立摘除）。宿主 apply
// 极薄——仅向 ac-webui 声明 boot graph 条目。
//
// 可摘除性（双向语义）：
//   · 卸本行 → boot graph 收缩 → goal 前端消费面消失（工具卡回落
//     文本渲染 + dock 条不渲染）；
//   · 卸后端行（ac-goal）→ 本行照常装载，RPC 失败 → fetch null →
//     dock 静默隐藏（三态空态语义）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-goal';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-goal',
  label: '目标（前端）',
  description: 'goal 域前端行（M28 P1）：goal 工具卡（tool-card:result-view 贡献）+ goal dock 条（tracking:dock-widget 贡献 order 20）；与 ac-goal 后端行双向可独立摘除',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收）
  const off = ctx.webui.declareClient({
    name: 'ui-goal',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
