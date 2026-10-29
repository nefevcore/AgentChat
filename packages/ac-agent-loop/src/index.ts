// ============================================================
// ac-agent-loop —— ReAct 循环插件行
//
// inject ['llm', 'tools']：两个能力服务由 ac-llm / ac-tools 提供，
// 缺任一服务本行保持 PENDING（不崩）；服务替换时本行自动回滚重载。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { AgentLoopService } from './service.ts';

export const name = 'ac-agent-loop';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'agent-loop',
  label: 'ReAct 循环',
  description: 'ReAct 编排（ctx.agentLoop）：run → [step → 推理/工具 → 收束]，边界全事件化（loop/*）',
  automatic: true,
};
export const inject = ['llm', 'tools'];

export function apply(ctx: Context) {
  ctx.plugin(AgentLoopService);
}

// runAddress / pairKey / ARCHIVE_REVIEW_META / isArchiveReviewRun /
// normalizeToolSpecs 已下沉 ac-core-utils（cr-318：跨行协议词汇单源，
// 消费方直连纯库免拉插件行）——先例同 GROUP_HINT_META，不留 re-export。
export { AgentLoopService };

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
