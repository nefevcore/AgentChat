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
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'archive',
  label: '超长归档',
  description: '会话超阈值触发整理归档（预算 per-Agent 覆盖）',
  automatic: true,
  fields: [
    { name: 'maxContextTokens', description: '归档触发阈值——上下文估算超过即整理归档' },
    { name: 'archiveTokenRatio', description: '归档保留比（整理后概要预算占比）' },
    { name: 'keepRecentRatio', description: '近期消息保留比（尾部不归档比例）' },
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
