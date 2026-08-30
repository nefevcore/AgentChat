// ============================================================
// ac-archive —— 归档编排插件行
//
// inject ['session', 'conversation', 'agents', 'tools']：
//   · session       —— 会话文件 owning 读写（records/history/compact，ADR-5）
//   · conversation  —— 整理 run 投递通道（M20 通道回归：deliver 同桶
//                      next-run 串行化排队；替代 agentLoop.run 直连旁路）
//   · agents        —— owning agent 解析（model/system/tools）+ settings['archive'] 预算覆盖
//   · tools         —— 整理提示词的生效工具集探测（write/memory_rewrite 自适应分支）
// 算法住 ac-archive-core 纯库（去重/截断/阈值）；timer 为可选运行时
// 依赖（ctx.interval 懒扫描，经 ctx.get 解析）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ArchiveService, type ArchiveRowOptions } from './service.ts';

export const name = 'ac-archive';

export const inject = ['session', 'conversation', 'agents', 'tools'];

export function apply(ctx: Context, options: ArchiveRowOptions = {}) {
  ctx.plugin(ArchiveService, options);
}

export { ArchiveService } from './service.ts';
export type { ArchiveRowOptions, ArchiveBatchItem } from './service.ts';
export type { ArchiveCompletedPayload } from './events.ts';
export type {} from './events.ts';
