// ============================================================
// ac-client-ui-skill —— skill 域前端行（M28 P1 §4.1 原案）
//
// 数据面行（暂无视觉贡献——技能区呈现内嵌于 ChatInput mention 组）：
// owning = skillsApi（skills/list 三源合成）。消费方跨包静态 import；
// 卸本行/后端行 → RPC 失败 → null → 技能区静默隐藏（三态契约）。
// ============================================================
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Context } from '@agentchat/cordis';

export const name = 'ac-client-ui-skill';

export const inject = ['webui'];

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ui-skill',
  label: '技能（前端）',
  description: 'skill 域前端行（M28 P1）：技能目录读面（全局/专属/工作区三源合成）；与 ac-skill 后端行双向可独立摘除',
  automatic: true,
};

export function apply(ctx: Context) {
  const off = ctx.webui.declareClient({
    name: 'ui-skill',
    entry: resolve(fileURLToPath(new URL('../client/index.ts', import.meta.url))),
    platform: 'web',
    phase: 'domain',
  });
  ctx.effect(() => off);
}
