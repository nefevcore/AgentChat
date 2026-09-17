// ============================================================
// ac-archive —— 归档编排插件行
//
// inject ['session', 'conversation', 'agents', 'tools']：
//   · session       —— 会话文件 owning 读写（records/history/compact，ADR-5）
//   · conversation  —— 整理 run 投递通道（M20 通道回归：deliver 同桶
//                      next-run 串行化排队；替代 agentLoop.run 直连旁路）
//   · agents        —— owning agent 解析（model/system/tools）+ settings['archive'] 预算覆盖
//   · tools         —— 整理提示词的生效工具集探测（write/edit 自适应分支）
// 算法住 ac-archive-core 纯库（去重/截断/阈值）；timer 为可选运行时
// 依赖（ctx.interval 懒扫描，经 ctx.get 解析）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ArchiveService, type ArchiveRowOptions } from './service.ts';
// 缺省值与实现单源（service 经同常量兜底；声明引用防漂移）
import { DEFAULT_ARCHIVE_BUDGETS, DEFAULT_SELF_CONTEXT_TOKENS } from 'ac-archive-core';

export const name = 'ac-archive';
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'archive',
  label: '超长归档',
  description: '会话超阈值触发整理归档（预算 per-Agent 覆盖）',
  automatic: true,
  fields: [
    { name: 'maxContextTokens', type: 'number', min: 0, step: 1000, default: DEFAULT_ARCHIVE_BUDGETS.maxContextTokens, description: '会话上下文预算上限（token）。实际触发阈值 = 本值 × archiveTokenRatio（缺省 50 万）' },
    { name: 'archiveTokenRatio', type: 'number', min: 0, max: 1, step: 0.05, default: DEFAULT_ARCHIVE_BUDGETS.archiveTokenRatio, description: '归档触发比（0~1）：上下文回放估算超过 maxContextTokens × 本值 → 触发整理归档' },
    { name: 'keepRecentRatio', type: 'number', min: 0, max: 1, step: 0.05, default: DEFAULT_ARCHIVE_BUDGETS.keepRecentRatio, description: '尾部保留预算比（0~1）：归档后保留最近消息的 token 预算 = maxContextTokens × 本值（缺省 3 万，超出部分移入归档段）' },
    { name: 'maxSelfContextTokens', type: 'number', min: 0, step: 1000, default: DEFAULT_SELF_CONTEXT_TOKENS, description: '自会话桶（agent~agent 运行日志）专项预算上限（token）——仅覆盖自会话桶的 maxContextTokens，触发阈值 = 本值 × archiveTokenRatio。缺省 40 万（低于通用 100 万：自会话是机制驱动的运行日志，无用户交互对冲，缺省即收紧锯齿峰值）；高频定时器 Agent（如每 30 分钟监控轮）可再调低，用户直答/委托会话不受影响' },
  ],
  listeners: [{ event: 'loop/after-run', role: '阈值检测触发归档', description: 'run 结束通知（持久化/审计/指标订阅）' }],
};


export const inject = ['session', 'conversation', 'agents', 'tools'];

export function apply(ctx: Context, options: ArchiveRowOptions = {}) {
  ctx.plugin(ArchiveService, options);
}

export { ArchiveService } from './service.ts';
export type { ArchiveRowOptions, ArchiveBatchItem } from './service.ts';
export type { ArchiveCompletedPayload } from './events.ts';
export type {} from './events.ts';
