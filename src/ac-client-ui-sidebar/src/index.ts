// ============================================================
// ac-client-ui-sidebar —— sidebar 基础件前端行（M27.2-2 出包之四）
//
// 基础七件之一（phase:'base'——封印前批次装载）：活动栏域。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目。
//
// client 半边资产（ownership §3.2 落点）：
//   · sidebar 席位出厂贡献（SidebarHost——活动栏 + 更多菜单 +
//     sidebar:plugin-actions 贡献面解析）；
//   · ui 面板状态 store（pinia，D10：listPanel/可见性/分屏/resize
//     ——webui stores/ui 门面 re-export 维持旧路径）；
//   · 系统小 API（fetchVersion/backupNow——Sidebar 菜单数据面）。
// 三面板壳（ListPanelsHost：agents/sessions/tracking）暂留 webui
// in-bundle（消费 conversation 域 store 门面——随 conversation 件
// 出包后迁入本包，届时 webui 残留 shim 退役）。
//
// 可摘除性：本件是 base 地基件——卸载即 boot graph base 行集变更
// → 前端整页重载（M27.2 §3.2 裁决）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-sidebar';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-sidebar',
  label: '活动栏（前端）',
  description: 'sidebar 基础件前端行：活动栏域（sidebar 席位出厂贡献 + ui 面板状态 store + 系统小 API；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-sidebar',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
