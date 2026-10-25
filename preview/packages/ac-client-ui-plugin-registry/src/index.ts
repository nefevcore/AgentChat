// ============================================================
// ac-client-ui-plugin-registry —— plugin-registry 域前端行
//（M28 P2 §5.2 settings 退化：插件库四件随域成行）
//
// 插件库大件 UI：目录/配置/市场三页签 + 暂存人审 + 扩展配置弹窗 +
// Agent 插件配置三视图（ExtToolsPane 供 AgentPane 跨包消费）。
// 经 settings:section 选举席贡献（pluginLibrary 节）；数据经
// settings 共享 store + plugin 域 RPC 契约面。卸本行 → 插件库节消失。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-plugin-registry';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-plugin-registry',
  label: '插件库（前端）',
  description: 'plugin-registry 域前端行（M28 P2）：插件库三页签 + 暂存人审 + 扩展配置弹窗 + Agent 插件配置视图（settings:section 选举席贡献）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-plugin-registry',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
