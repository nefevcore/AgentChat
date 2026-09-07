// ============================================================
// ac-client-ui-agents —— agents 域前端行（M27.1，D19 改裁）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-agents 后端行
// 完全解耦（唯一联系 = RPC 契约面 agents/* + runs/snapshot 名册合成；
// 双向可独立摘除）。宿主 apply 极薄——仅向 ac-webui 声明 boot graph
// 条目（前端装配序列第④步按图装载 client 模块）。
//
// 行间依赖（§2.5 机制已成立）：本行 client 半边提供 ctx.roster——
// ui-group/ui-singles 等 UI 行 inject 'roster'（fiber 等待，装载序无关）。
//
// 可摘除性（M27.1 双向语义）：
//   · 卸本行 → boot graph 收缩 → 名册/选择消费面消失（ctx.roster 不可
//     解析，依赖行 fiber 等待/空态）；后端 ctx.agents 照常；
//   · 卸后端行（ac-agents）→ 本行照常装载，名册 RPC 失败 → 拉取静默
//     降级（warn + 空名册）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-agents';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-agents',
  label: 'Agent 名册（前端）',
  description: 'agents 域前端行：名册身份面 ctx.roster（RosterCore 名册/预设/选择 + 显示名/头像解析；boot graph 条目声明 + client 半边装载；与 ac-agents 后端行双向可独立摘除）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-agents',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
