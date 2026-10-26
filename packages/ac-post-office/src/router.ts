// ============================================================
// router.ts —— 邮局投递路由（B1 三通道 + 扇出）
//
// 通道决策：可达（可达表命中）→ 直投 hint；不可达 → 发件箱滞留
//（at-least-once）。多播地址（group）→ 逐成员展开投递（扇出 = 邮局
// 执行面，群拓扑在数据根）。降级不改变语义只改变路径（D2）。
// ============================================================

import type { Envelope } from 'ac-envelope-core';
import { entersInbox, budgetAfterReceive } from 'ac-envelope-core';
import type { ConversationRegistry, ReachabilityTable } from './registry.ts';

/** 投递目标端点 id（编排面按需拉起的寻址面——agent 端点） */
export type RouteTarget = string;

/** 单端点投递指令（IO 半边——transport 执行） */
export type DeliveryInstruction =
  | { channel: 'direct'; to: string; transportHint: string; envelope: Envelope; hop: number }
  | { channel: 'outbox'; to: string; envelope: Envelope; reason: 'unreachable' | 'no-hint' };

/** 扇出解析面（多播地址表——群拓扑在数据根，邮局只持执行期快照） */
export interface MulticastTable {
  /** group 地址 → 成员端点清单（宿主从数据根拓扑读出后注入） */
  membersOf(address: string): string[] | undefined;
}

/**
 * 投递路由（纯决策——不碰 IO）：
 *   · uuid 登记校验先行（冲突 fail-loud——防身份冒用）
 *   · 多播地址展开（跳过发送方自身——回声不投）
 *   · 可达 → direct（hop+1 经中继）；不可达 → outbox 滞留
 */
export function routeEnvelope(
  envelope: Envelope,
  deps: { registry: ConversationRegistry; reach: ReachabilityTable; multicast?: MulticastTable },
): DeliveryInstruction[] {
  // uuid 登记校验（participants 近似 = sender + to——多播时 to = 组地址，
  // 登记面用展开后成员集合）
  const members = deps.multicast?.membersOf(envelope.to);
  const participants = members !== undefined
    ? [...new Set([envelope.sender, ...members])]
    : [envelope.sender, envelope.to];
  const reg = deps.registry.register(envelope.uuid, participants);
  if (reg.kind === 'conflict') {
    throw new Error(
      'uuid 登记冲突：' + envelope.uuid
      + ' 已登记 [' + reg.registered.participants.join(',') + ']'
      + ' 来信 [' + reg.incoming.join(',') + ']——fail-loud（防身份冒用）',
    );
  }
  const targets = members !== undefined
    ? members.filter((m) => m !== envelope.sender)
    : [envelope.to];
  const hop = (envelope.hop ?? 0) + 1; // 经一次邮局中继 +1
  return targets.map((to): DeliveryInstruction => {
    const hint = deps.reach.hintFor(to);
    if (hint === undefined) {
      return { channel: 'outbox', to, envelope, reason: 'no-hint' };
    }
    return { channel: 'direct', to, transportHint: hint, envelope: { ...envelope, hop }, hop };
  });
}

/**
 * 接收方入站处理（壳侧消费决策——A4 inbox 边界 + budget 语义）：
 *   · 非 message kind / budget=0 → ledger-only（不进 inbox）
 *   · user 直发 → 重置满额
 */
export function inboxDecision(envelope: Envelope): {
  entersInbox: boolean;
  budgetAfter: number;
} {
  const after = budgetAfterReceive(envelope.budget, envelope.sender);
  return {
    entersInbox: entersInbox(envelope.kind, after),
    budgetAfter: after,
  };
}
