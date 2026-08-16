// ============================================================
// @agentchat/agent-loop/src/context.ts —— L1 数据流统一上下文
//
// 类型契约（CurrentContext / MessageInbox / 七类钩子 / 中断处理器）
// 已迁移至 @agentchat/contracts；本文件保留运行时助手：
//   createContext / enqueue / followup / steer / inject / drainInbox
// 并 re-export 契约类型 + 保留旧 pushSteer/drainSteer 兼容。
//
// inbox 投递语义：
//   · next-turn：当前 run 结束后由 router 取一条作为新 run 的 currentMessage；
//     loop 内部不消费（避免运行中 followup 被吞进当前 run）。
//   · next-step：steering / 注入上下文。loop 每个 ReAct step 开始前消费全部；
//     step 自然结束时若队列非空则继续，解决"末轮 pushSteer 丢失"竞态。
// ============================================================

import type { CurrentContext, InboxTarget, MessageInbox } from '@agentchat/contracts';
import type { AgentMessage } from '@agentchat/types';

export * from '@agentchat/contracts';

/** 创建执行快照（inbox 缺省为双空队列；显式 undefined 不覆盖缺省） */
export function createContext(
  input: Omit<CurrentContext, 'inbox'> & { inbox?: MessageInbox },
): CurrentContext {
  const { inbox, ...rest } = input;
  return { ...rest, inbox: inbox ?? { nextTurn: [], nextStep: [] } };
}

/** 按目标入队（router 层 wakeup 决策的底层原语） */
export function enqueue(ctx: CurrentContext, message: AgentMessage, target: InboxTarget): void {
  ctx.inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(message);
}

/** followup：入队 next-turn（router 在 idle 时据此开新 run；loop 自身不消费） */
export function followup(ctx: CurrentContext, message: AgentMessage): void {
  enqueue(ctx, message, 'next-turn');
}

/** steer：入队 next-step（当前 run 下一 ReAct step 消费；idle 时由 router 开新 run） */
export function steer(ctx: CurrentContext, message: AgentMessage): void {
  enqueue(ctx, message, 'next-step');
}

/** inject：入队 next-step 但不唤醒（idle 时挂起，等待 followup/steer 唤醒） */
export function inject(ctx: CurrentContext, message: AgentMessage): void {
  enqueue(ctx, message, 'next-step');
}

/** 消费指定队列的全部消息（loop 每步调用 next-step） */
export function drainInbox(ctx: CurrentContext, target: InboxTarget): AgentMessage[] {
  const list = target === 'next-turn' ? ctx.inbox.nextTurn : ctx.inbox.nextStep;
  return list.splice(0);
}

// ---- 旧 API 兼容（原 ctx.steer 语义 = next-step） ----

/** 注入转向消息（用户/其他 Agent 中途插入的指令，按会话隔离） */
export function pushSteer(ctx: CurrentContext, message: AgentMessage): void {
  steer(ctx, message);
}

/** 消费全部转向消息（loop 每步调用，返回并清空队列） */
export function drainSteer(ctx: CurrentContext): AgentMessage[] {
  return drainInbox(ctx, 'next-step');
}
