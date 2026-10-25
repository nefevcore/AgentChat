// ============================================================
// ac-client-ui-group —— group 域前端行（M27.1，D19 改裁）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-group 后端行
// 完全解耦（唯一联系 = RPC 契约面 group/* + group/* 帧；双向可独立
// 摘除）。宿主 apply 极薄——仅向 ac-webui 声明 boot graph 条目（前端
// 装配序列第④步按图装载 client 模块）。
//
// 行间依赖（§2.5 机制已成立）：client 插件 inject ['rpc','sessions',
// 'roster']——roster 由 ui-agents 行提供，fiber 等待、装载序无关。
//
// 可摘除性（M27.1 双向语义）：
//   · 卸本行 → boot graph 收缩 → 群入口/群聊视角消费面消失
//    （ctx.groups 不可解析），宿主不残废；后端照常；
//   · 卸后端行（ac-group）→ 本行照常装载，group/list RPC 失败 →
//     拉取静默降级（warn + 空清单）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-group';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-group',
  label: '群聊（前端）',
  description: 'group 域前端行：群聊投影 ctx.groups（群列表/活跃群/选中协调；boot graph 条目声明 + client 半边装载；与 ac-group 后端行双向可独立摘除）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-group',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
