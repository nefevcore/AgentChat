// ============================================================
// ac-client-ui-ask —— ask 域前端行（cr-765 #4）
//
// 与 ac-ask-questions 后端行完全解耦（唯一联系 = 注入行 payload 数据面）；
// 双向可独立摘除：卸本行 → 问答卡回落通用注入卡；卸后端行 → 无注入行。
// 宿主 apply 极薄——仅向 ac-webui 声明 boot graph 条目。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-ask';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-ask',
  label: '问答卡（前端）',
  description: 'ask 域前端行：ask_questions 注入行专用问答卡（inject-card:view 席位贡献；与 ac-ask-questions 后端行双向可独立摘除）',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-ask',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}