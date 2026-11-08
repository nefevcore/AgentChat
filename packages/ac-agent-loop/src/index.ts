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
  // ENV_MODEL 段（cr-881 迁）注册住 AgentLoopService 构造器：本行 inject
  // ['llm','tools']，apply 里走 ctx.agentLoop 即 "cannot get property without
  // inject"（自注册场景——cr-538 先例服务实例直引）。
}

// runAddress / pairKey / ARCHIVE_REVIEW_META / isArchiveReviewRun /
// normalizeToolSpecs 已下沉 ac-core-utils（cr-318：跨行协议词汇单源，
// 消费方直连纯库免拉插件行）——先例同 GROUP_HINT_META，不留 re-export。
export { AgentLoopService };

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';

// PromptSection 注册制契约（cr-881 注册制；cr-944 动态化）：核心惯例位 + 校验 + 组装纯函数
export {
  SECTION_ORDER,
  sectionOrder,
  validateSectionName,
  validateSectionOrder,
  assembleSystemPrompt,
} from './sections.ts';
export type { SectionContribution, CoreSectionName, RegisteredSection, AssembleSection } from './sections.ts';
