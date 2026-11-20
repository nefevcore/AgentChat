// ============================================================
// router.ts —— 邮局投递路由（B1 三通道 + 扇出）
//
// 通道决策：可达（可达表命中）→ 直投 hint；不可达 → 发件箱滞留
//（at-least-once）。多播地址（group）→ 逐成员展开投递（扇出 = 邮局
// 执行面，群拓扑在数据根）。降级不改变语义只改变路径（D2）。
// ============================================================

import type { Envelope } from 'ac-envelope-core';
import { isReservedEndpointId } from 'ac-agents-core';
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
  // 登记面用展开后成员集合）。
  // cr-1177：保留端点（host）sender 的信不做近似重算——基础设施端点不是
  // 会话参与者（D1），其回投信 uuid 恒为已登记会话键（uuid 精确定位会话），
  // 按 registry 现有登记直接放行；近似重算会把 [agent, host] 撞进已登记的
  // [user, agent]（conflict fail-loud → 回执滞留 outbox 静默——存量缺陷）。
  // 未登记 uuid 仍走正常登记面（fail-loud 保真）。
  const infraSender = isReservedEndpointId(envelope.sender);
  const members = deps.multicast?.membersOf(envelope.to);
  if (infraSender && deps.registry.lookup(envelope.uuid) !== undefined) {
    // 基础设施回投已登记会话——放行（不重算 participants；防冒用面不受影响：
    // 冒用会话键的攻击者须先通过端点可达验证才能投进桶，host 端点恒不可达冒用）
  } else {
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
