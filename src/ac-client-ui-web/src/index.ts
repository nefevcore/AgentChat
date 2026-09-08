// ============================================================
// ac-client-ui-web —— 工具卡前端行（M28 P2 §2.2 镜像表：ac-web-tools）
//
// 卡片经 tool-card:result-view 席位贡献；行卸载 → def 消失 → resolve
// 回落默认文本渲染。与后端行经 RPC 契约面解耦，双向可独立摘除。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-web';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-web',
  label: 'Web 工具卡（前端）',
  description: 'ac-web-tools 域工具卡前端行（M28 P2 镜像表）：web_search + 浏览器族正则（fetch_webpage 等 11 工具）→ ToolResultWeb',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-web',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}