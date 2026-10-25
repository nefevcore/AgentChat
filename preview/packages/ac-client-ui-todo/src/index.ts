// ============================================================
// ac-client-ui-todo —— todo 域前端行（M27.1，D19 改裁）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-todo 后端行
// 完全解耦（唯一联系 = RPC 契约面 todo/get；双向可独立摘除）。
// 宿主 apply 极薄——仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第④步按图装载 client 模块）。
//
// 可摘除性（M27.1 双向语义）：
//   · 卸本行 → boot graph 收缩 → todo 前端消费面消失（工具卡回落
//     文本渲染、dock 无贡献）；后端 todo 工具照常（RPC 可调）；
//   · 卸后端行（ac-todo）→ 本行照常装载，todo/get RPC 失败 →
//     null → 三态静默空态。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-todo';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-todo',
  label: '待办清单（前端）',
  description: 'todo 域前端行：工具结果卡片 + 任务清单 dock 卡（boot graph 条目声明 + client 半边装载；与 ac-todo 后端行双向可独立摘除）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-todo',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
