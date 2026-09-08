// ============================================================
// ac-client-ui-settings —— settings 基础件前端行
//（M27.2-2 出包之六）
//
// 基础七件之一（phase:'base'——封印前批次装载）：设置域。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第③步 base 阶段按图装载 client 模块）。
//
// client 半边资产（ownership §3.2 落点）：
//   · settings:main-view / agent-pane:tab 两席位声明（★settings-tab:
//     global / settings-tab:agent 别名，D13）+ overlay 席位出厂贡献
//    （SettingsOverlayHost）；
//   · SettingsPanel 壳+左树+保存编排 + 模型池管理（PoolManager）/
//     插件库（PluginLibraryPane）/扩展设置（ExtensionSettingsModal）/
//     定时面板（TimerPane）等 12 组件；
//   · 类型化 API 层（settings/api——config/pool/assembly/plugin/
//     timer 域 rpc 直连，rpc 缺省 = clientRuntime 契约面）+ schema
//     归一化 + settings 页签解析面（extensionTabs）+ 旧 slot 目录
//    （slotCatalog——bridge 注册面留 webui re-export）。
//
// 可摘除性：本件是 base 地基件——卸载即 boot graph base 行集变更
// → 前端整页重载（M27.2 §3.2 裁决）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-settings';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-settings',
  label: '设置（前端）',
  description: 'settings 基础件前端行：设置域（settings/agent 页签席位 + 设置面板 overlay 出厂贡献 + 类型化 API/schema + 页签解析面 + 旧 slot 目录；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-settings',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
