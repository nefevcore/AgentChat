// ============================================================
// ac-client-ui-run-nodes —— 会话节点前端行（cr-230）
//
// run 骨架面板：当前会话每 run 的用户消息为节点（时间 + 摘要 +
// 运行中指示），点击 = 主区定位到该消息（uiStore.revealMsg 意图。
// 纯前端行：数据源 = ctx.sessions feed（conversation 基础件投影），
// 无后端行——行缺席时面板消失、无任何宿主残缺。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-run-nodes';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-run-nodes',
  label: '会话节点（前端）',
  description: '会话 run 骨架面板（cr-230）：每 run 用户消息为节点、点击跳转主区定位该消息；aux-sidebar 选区贡献，无后端行',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-run-nodes',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
