// ============================================================
// ac-conversation —— 会话状态机插件行
//
// inject ['router', 'agentLoop']：router = 纯转发投递（零会话状态，
// ADR-1）；agentLoop = steer 注入（Service 方法）与 runAddress 寻址。
// config（{ root? }）：root 给定即启用待投持久化（next-turn 队列
// 落盘，崩溃/42 重启后回放恢复——src pending-resume 最小闭环，M15）。
// 缺服务时本行 PENDING，服务到位自动激活。
//
// 事件目录见 ./events.ts：conversation/steered（steer 注入通知，
// ac-session 据此入账不经 router 的消息）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ConversationService } from './service.ts';
import type { ConversationRowOptions } from './service.ts';

export const name = 'ac-conversation';

export const inject = ['router', 'agentLoop'];

export function apply(ctx: Context, options: ConversationRowOptions = {}) {
  ctx.plugin(ConversationService, options);
}

export { ConversationService } from './service.ts';
export type { ConversationRowOptions } from './service.ts';

// agentOf 命名读取器（M25 §3.2：owning 包导出，类型锚定自家事件签名）
export { agentOfSteered } from './readers.ts';

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';
