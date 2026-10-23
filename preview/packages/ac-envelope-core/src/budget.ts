// ============================================================
// budget.ts —— 防自激预算语义（协议规格 A1 budget 字段 + A4 inbox 边界）
//
// budget = 收到本信后至多可自动唤醒 run 的次数（类 TTL）：
//   · 每次自动唤醒 -1；0 = 不再触发 run（只落账不激活，不入 inbox）；
//   · user 直发重置满额（user 是预算之源）；
//   · 缺省 = 3（MAX_AUTO_WAKES 同源，现状常量语义平移）。
// F-8 链式传播（配额挂 uuid 因果链）待钉——本模块只做单信封语义。
// ============================================================

import { DEFAULT_BUDGET, type EnvelopeKind, type EndpointId } from './envelope.ts';

/** 是否入 inbox（A4：触发 run 的信才排队）——receipt 落账+异步消费、
 * grant/revoke 生效走每 run 前重读（E 节），均不触发 run；budget=0 只落账 */
export function entersInbox(kind: EnvelopeKind, budget: number): boolean {
  if (kind !== 'message') return false;
  return budget > 0;
}

/** user 直发判定（预算之源——重置满额的唯一端点） */
export function isBudgetSource(sender: EndpointId): boolean {
  return sender === 'user';
}

/** 收信后预算推进：user 直发 → 重置满额；否则不变（消耗在自动唤醒时） */
export function budgetAfterReceive(budget: number, sender: EndpointId): number {
  return isBudgetSource(sender) ? DEFAULT_BUDGET : budget;
}

/** 自动唤醒消耗：-1，下限 0（0 = 只落账） */
export function consumedByAutoWake(budget: number): number {
  return Math.max(0, budget - 1);
}
