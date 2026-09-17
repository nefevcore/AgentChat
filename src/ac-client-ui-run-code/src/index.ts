// ============================================================
// ac-client-ui-run-code —— 工具卡前端行（M28 P2 §2.2 镜像表：ac-run-code）
//
// 卡片经 tool-card:result-view 席位贡献；行卸载 → def 消失 → resolve
// 回落默认文本渲染。与后端行经 RPC 契约面解耦，双向可独立摘除。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-run-code';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-run-code',
  label: '程序卡（前端）',
  description: 'ac-run-code 域工具卡前端行（M28 P2 镜像表）：run_code → ToolResultRunCode 程序卡（TS 代码视图 + 子调用摘要 + 返回值）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-run-code',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
