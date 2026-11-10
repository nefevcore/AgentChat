// ============================================================
// ac-jobs —— 后台任务插件行
//
// 本包是任务域契约的 owning package：域类型在 ./src/contract.ts，
// job/* 事件目录在 ./src/events.ts（谁 emit 谁声明）。
// bash / subagent 等异步能力 producer inject ['jobs'] 登记；
// job 完成通知回投（job/settled → conversation.deliver sender:'event'）
// 在 ./wakeup.ts——cr-453 裁决 job-wakeup 随迁壳 jobs 行内，cr-992 补齐。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { JobsService, type JobsRowOptions } from './service.ts';
import { applyJobWakeup } from './wakeup.ts';

export const name = 'ac-jobs';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'jobs',
  label: '后台任务',
  description: '后台任务服务（ctx.jobs）：进程内 job 注册/查询/中止 + job/settled 完成事件',
  automatic: true,
};

export function apply(ctx: Context, options: JobsRowOptions = {}) {
  // 纯后端行（M27.1，D19 改裁）：前端半边 = ac-client-ui-jobs 独立 UI 行
  ctx.plugin(JobsService, options);
  // 完成通知回投（cr-992 随迁补齐）：conversation 行未装时静默跳过（行组合可选）
  applyJobWakeup(ctx);
}

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';

export { JobsService } from './service.ts';
export type { JobsRowOptions } from './service.ts';
