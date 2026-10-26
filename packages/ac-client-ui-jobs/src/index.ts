// ============================================================
// ac-client-ui-jobs —— jobs 域前端行（M27.1，D19 改裁）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-jobs 后端行
// 完全解耦（唯一联系 = RPC 契约面 jobs/list·jobs/kill + job/* 帧；
// 双向可独立摘除）。宿主 apply 极薄——仅向 ac-webui 声明 boot graph
// 条目（前端装配序列第④步按图装载 client 模块）。
//
// 可摘除性（M27.1 双向语义）：
//   · 卸本行 → boot graph 收缩 → jobs 前端消费面消失（ctx.jobBoard
//     不可解析 → RunTrackingPanel 空态）；后端 ctx.jobs 照常；
//   · 卸后端行（ac-jobs）→ 本行照常装载，jobs/list RPC 失败 →
//     null → 三态静默空态。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-jobs';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-jobs',
  label: '后台任务（前端）',
  description: 'jobs 域前端行：任务清单投影 ctx.jobBoard（jobs/killing + refresh/kill；boot graph 条目声明 + client 半边装载；与 ac-jobs 后端行双向可独立摘除）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-jobs',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
