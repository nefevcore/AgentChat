// ============================================================
// ac-tools —— 工具注册中心插件行
//
// 本包是工具域契约的 owning package：域类型在 ./src/contract.ts，
// tool/* 事件目录在 ./src/events.ts（谁 emit 谁声明）。
// 各工具域薄行 inject ['tools'] 注册工具；注册随插件卸载自动回收。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ToolsService } from './service.ts';

export const name = 'ac-tools';

export function apply(ctx: Context) {
  ctx.plugin(ToolsService);
}

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';

export { ToolsService } from './service.ts';

// agentOf 命名读取器（M25 §3.2：owning 包导出，类型锚定自家 contract）
export { agentOfExecution, agentOfToolTransform, agentOfToolCall } from './readers.ts';
