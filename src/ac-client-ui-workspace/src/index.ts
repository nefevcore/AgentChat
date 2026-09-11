// ============================================================
// ac-client-ui-workspace —— workspace 域前端行（M27.1，D19 改裁）
//
// 前端行全族 ac-client-ui-*：包名即身份——本行与 ac-workspace 后端行
// 完全解耦（唯一联系 = REST 契约面 /api/workspaces；双向可独立摘除）。
// 宿主 apply 极薄——仅向 ac-webui 声明 boot graph 条目（前端装配序列
// 第④步按图装载 client 模块）。
//
// 可摘除性（M27.1 双向语义）：
//   · 卸本行 → boot graph 收缩 → workspace 前端消费面消失
//    （ctx.workspaceBoard 不可解析 → 会话树工作区根消失）；
//   · 卸后端行（ac-workspace）→ 本行照常装载，REST 失败 → 拉取
//     静默降级（warn + 空清单）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-workspace';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-workspace',
  label: '工作区（前端）',
  description: 'workspace 域前端行（M28 P1 行完整）：ctx.workspaceBoard 工作区投影 + 文件预览（overlay 席位贡献）+ 工作区树（aside 席位选区条目——def id workspace，自带 rail 收起态资产，2026-11 构造对齐·层级修正）+ 路径选择/上传/目录浏览数据面；与 ac-workspace 后端行双向可独立摘除',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-workspace',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
