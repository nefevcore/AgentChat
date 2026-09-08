// ============================================================
// ac-client-ui-layout —— layout 基础件前端行
//（M27.2-2 出包之七——基础七件收官）
//
// 基础七件之一（phase:'base'——封印前批次装载）：应用壳域。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第③步 base 阶段按图装载 client 模块）。
//
// client 半边资产（ownership §3.2 落点）：
//   · root 席位出厂占用（AppFrame——原 App.vue 骨架，DOM/CSS 零改动）
//     + sidebar/list-panel/main/overlay 四 seat 声明 + main:perspective
//     / main:workspace / sidebar:plugin-actions 别名席；
//   · 视角注册表解析面（perspectives——main:perspective owning 件）；
//   · 主区件（PerspectiveHost / 运行矩阵 RunTracking）+ overlay 件
//     （TokenUsage / VersionDialog）。
//     M28 P1 起工作区树/文件预览（ui-workspace）、建群弹窗（ui-group）
//     = 域行席位贡献；P0-2 起四视角出厂贡献随 owning 行走。
//
// 可摘除性：本件是 base 地基件——卸载即 boot graph base 行集变更
// → 前端整页重载（M27.2 §3.2 裁决）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-layout';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-layout',
  label: '应用壳（前端）',
  description: 'layout 基础件前端行：应用壳域（root 席位出厂占用 + 四 seat 声明 + 视角注册表解析面 + 主区/overlay 件；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-layout',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
