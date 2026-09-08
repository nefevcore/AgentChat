// ============================================================
// ac-client-ui-subagent —— 工具卡前端行（M28 P2 §2.2 镜像表：ac-subagent）
//
// 卡片经 tool-card:result-view 席位贡献；行卸载 → def 消失 → resolve
// 回落默认文本渲染。与后端行经 RPC 契约面解耦，双向可独立摘除。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-subagent';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-subagent',
  label: '子Agent 工具卡（前端）',
  description: 'ac-subagent 域工具卡前端行（M28 P2 镜像表）：subagent → ToolResultSubagent（action 分发清单卡）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-subagent',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}