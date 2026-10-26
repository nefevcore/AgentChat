// ============================================================
// ac-client-ui-browser —— 工具卡前端行（M28 P2 §2.2 镜像表：browser 域）
//
// 卡片经 tool-card:result-view 席位贡献；行卸载 → def 消失 → resolve
// 回落默认文本渲染。与后端行经 RPC 契约面解耦，双向可独立摘除。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-browser';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-browser',
  label: '浏览器工具卡（前端）',
  description: 'browser 域 域工具卡前端行（M28 P2 镜像表）：browser → ToolResultBrowser（多动作 tab / steps 批量）；截图预览经 workspaceFile',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-browser',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}