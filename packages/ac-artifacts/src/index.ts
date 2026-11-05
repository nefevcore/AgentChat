// ============================================================
// ac-artifacts —— 产出物引用指引行（cr-881 system prompt 去中心化新行）
//
// 极薄事件行：GUIDELINES_ARTIFACTS 段（有文件产出能力即适用），无工具无服务。
// 门控 = 写面任一在场（write/edit/str_replace_editor/bash/pwsh——shell 也能产出文件）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { widenToolsForGating } from 'ac-agents';

export const name = 'ac-artifacts';

import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'artifacts',
  label: '产出物引用指引',
  description: 'GUIDELINES_ARTIFACTS 段：创建/修改文件后列出产出文件、优先改既有文件、<file> 标注教学（写面工具在场才注入）',
  automatic: true,
};

export const inject = ['agentLoop'];

export function apply(ctx: Context) {
  ctx.agentLoop.registerPromptSection({
    name: 'GUIDELINES_ARTIFACTS',
    text: (request) => {
      const names = new Set(widenToolsForGating(ctx, request.agent, request.conversationId, request.tools));
      const writable = names.has('write') || names.has('edit') || names.has('str_replace_editor') || names.has('bash') || names.has('pwsh');
      if (!writable) return '';
      return '产出物引用：创建或修改文件后，最终回复中简要列出主要产出文件，路径用 markdown 行内代码格式；优先改既有文件而非新建（含 markdown 文档——除非用户明确要求，不主动创建文档文件）。交付文档/报告等成果物时，可用 <file path="完整路径">文件名</file> 标注——渲染为可点击预览链接；仅在正文自然提及成果物时使用，不必为罗列改动的源码文件而标注。';
    },
  }, 'ac-artifacts');
}