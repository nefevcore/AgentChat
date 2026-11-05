// ============================================================
// ac-conduct —— 行为基线行（cr-881 system prompt 去中心化新行）
//
// 极薄事件行：CONDUCT 段（专业客观——技术准确优先于迎合），无工具无服务。
// 恒注入（裁决 2026-11-03：行为基线不依赖工具面；原「指引块非空才附」
// 是装配副作用非设计意图）。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-conduct';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'conduct',
  label: '行为基线（专业客观）',
  description: 'CONDUCT 段：技术准确与事实正确优先于迎合用户——必要时明确反对并给依据（恒注入）',
  automatic: true,
};

export const inject = ['agentLoop'];

export function apply(ctx: Context) {
  ctx.agentLoop.registerPromptSection({
    name: 'CONDUCT',
    text: () => '专业客观：优先技术准确与事实正确，不迎应用户观点——必要时明确反对并给依据；不确定时先查证再下结论，不为了让用户满意而附和。',
  }, 'ac-conduct');
}