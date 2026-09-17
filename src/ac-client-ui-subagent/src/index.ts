// ============================================================
// ac-client-ui-subagent —— subagent 域前端行（工具卡 + 会话视角）
//
// 卡片经 tool-card:result-view 席位贡献；会话视角经 main:perspective
// 席位贡献（subagent-session-view-plan §3.4）。行卸载 → def 消失 →
// resolve 回落默认文本渲染 / 视角失去选举资格。与后端行经 RPC 契约面
// 解耦，双向可独立摘除。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-subagent';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-subagent',
  label: '子Agent 工具卡·会话视角（前端）',
  description: 'subagent 域前端行：subagent 工具卡（action 分发清单卡）+ 子 Agent 会话只读视角（运行跟踪面板点击进入——历史回放，工具卡/思维链经 steps[] 落盘重建）',
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