// ============================================================
// ac-client-ui-tool —— tool 基础件前端行（M27.2-2 出包之三）
//
// 基础七件之一（phase:'base'——封印前批次装载）：工具结果视图域。
// 无后端行——宿主半边仅向 ac-webui 声明 boot graph 条目（前端装配
// 序列第③步 base 阶段按图装载 client 模块）。
//
// client 半边资产（ownership §3.2 落点）：
//   · tool-card:result-view 席位声明（★toolResultViews 收编目标；
//     keyed presentation——精确名/正则族/priority 选举）；
//   · 内置 8 组件出厂注册（bash/read/write/edit/web/browser/subagent/
//     goal 卡；第三方/域插件工具卡经 registerToolResultView 动态追加
//     ——同 match 后注册者替换）；
//   · workspace 文件 REST 读取小件 + goal 卡归一化纯函数随件走
//    （ToolResult 组件的数据管线）。
//
// 可摘除性：本件是 base 地基件——卸载即 boot graph base 行集变更
// → 前端整页重载（M27.2 §3.2 裁决：基础件不可动态回收）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-tool';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-tool',
  label: '工具卡（前端）',
  description: 'tool 基础件前端行：工具结果视图域（tool-card:result-view 席位 + 内置 8 卡出厂注册；boot graph base 阶段装载）',
  automatic: true,
};

export function apply(ctx: Context) {
  // boot graph 声明（注册即归属：disposer 经 ctx.effect 挂本行 fiber——
  // 卸载即声明级联回收；apply 返回值在 namespace 插件形态下不被收集）
  const off = ctx.webui.declareClient({
    name: 'ui-tool',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'base',
  });
  ctx.effect(() => off);
}
