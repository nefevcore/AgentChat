// ============================================================
// ac-client-ui-theme —— theme 基础件前端行（M27.2-2 出包首件）
//
// 基础七件之一（phase:'base'——封印前批次装载）：明暗主题视图状态。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第③步 base 阶段按图装载 client 模块）。
//
// ctx.theme（client 半边提供；服务名与服务端占名无碰撞，D22）：
//   · 视图状态（明暗主题）归本件私有（§0.3 层 1）——不跨插件暴露
//     store 本体；他件影响主题走服务方法（toggle/set）；
//   · 持久化 localStorage('agentchat.theme') + html class 应用 +
//     highlight.js 主题切换事件（theme-changed）；
//   · 双模门面：webui stores/theme.ts 转发 ctx.theme.core（runtime
//     在场）/ 独立 Core（无 runtime 单测）。
//
// 可摘除性：本件是 base 地基件——卸载即 boot graph base 行集变更
// → 前端整页重载（M27.2 §3.2 裁决：基础件不可动态回收）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-theme';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-theme',
  label: '主题（前端）',
  description: 'theme 基础件前端行：明暗主题视图状态（ctx.theme：toggle/applyThemeClass + localStorage 持久化；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-theme',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
