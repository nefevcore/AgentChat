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
//     + 页面骨架 seat 声明（2026-11 语义定整——VSCode 布局同款词汇）：
//     activity-bar（活动栏）/ primary-sidebar（主侧边栏）/ main（主
//     面板，keyed 选举「主区视图」多选一——MainViewHost 解析）/
//     aux-sidebar（辅助侧边栏，keyed 选举「选区」多选一——AuxSidebarHost
//     解析：工作区 = 众多选区之一，rail 收起态资产随条目 def 住域行）/
//     overlay + menu-bar/bottom-panel/status-bar 三骨架预留席（declare
//     占名、无 outlet）+ main:perspective/activity-bar:plugin-actions 别名席；
//   · 视角注册表解析面（perspectives——main:perspective owning 件）
//     + 主区视图/选区选举面（mainViews/auxSidebarViews）；
//   · 主区件（PerspectiveHost/MainViewHost）+ 区域宿主（AuxSidebarHost）
//     + 左侧导航区两壳（ActivityBarHost 活动栏 / PrimarySidebarHost 主侧边栏
//     三面板壳 + primary-sidebar:domain 选举席）与布局状态 uiStore
//     （2026-11 自 ac-client-ui-sidebar 行归并——出生史：v0.6.2 L4
//     全量切 src 时自 monolith clients/base/sidebar.ts 原样升包，
//     M28 P2 三面板域行贡献化后即为骨架性资产，归位壳件）。
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
