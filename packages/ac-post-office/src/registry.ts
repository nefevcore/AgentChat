// ============================================================
// registry.ts —— 会话登记面（cr-1213：键形权威制）+ 在场可达表
//
// 名册按 uuid 键形分派（登记集优先）：
//   1. 群成员流键（gid~member）——群行 authoritative 注入（boot/join
//      重放 setRoster，无条件覆盖支持名册演化）；
//   2. 1v1 对键（a~b）——键形反演名册 = 两端点（键即权威，首封无毒化）；
//   3. UUIDv7 形等其余键形——首见 [sender, to]（对话两端，A3 语义）。
// 机制域 sender（host/@ 群地址）非会话发言：首见 defer 不登记（回执先于
// 真实首信不毒化），已登记恒放行。来信校验 = sender 名册成员判定，集外
// fail-loud（防身份冒用——cr-641/1046/1177 三连点修的根除语义：任何一
// 封信都无法毒化会话键登记）。to 退出校验面：投递目标由路由可达性裁决。
// 在场可达表：endpointId → transportHint（guardian adopt 时登记——
// 壳 boot.ready 携带 hint，宿主标记可达）。
// ============================================================

import { participantsOfKey } from 'ac-core-utils';
import { isMechanismEndpointId } from 'ac-agents-core';

/** 会话登记条目（uuid → participants） */
export interface ConversationEntry {
  uuid: string;
  participants: string[];
  firstSeenAt: string;
}

export type RegisterResult =
  | { kind: 'registered'; entry: ConversationEntry }
  | { kind: 'consistent' }
  | { kind: 'conflict'; registered: ConversationEntry; incoming: string[] };

/** uuid 登记表（内存——邮局会话期状态；持久化随 M5+ 按需）。键形键
 * （1v1/自会话）重启后丢失无需恢复——首封再来信按键形反演重建，结果
 * 与重启前恒一致（键即权威）；群流键由群行 boot 重放重建。 */
export class ConversationRegistry {
  private readonly byUuid = new Map<string, ConversationEntry>();

  /** authoritative 名册注入（群行 boot/join 重放）：无条件覆盖——名册
   *  演化（join/leave）不以 conflict 拦截，且可矫正 boot 窗口内键形反演
   *  的临时误登（群流键与 1v1 键词法同形，键面不可分辨）。 */
  setRoster(uuid: string, participants: string[]): void {
    if (uuid.length === 0) throw new Error('uuid 不得为空');
    const norm = [...new Set(participants)].sort();
    const existing = this.byUuid.get(uuid);
    if (existing !== undefined) existing.participants = norm;
    else this.byUuid.set(uuid, { uuid, participants: norm, firstSeenAt: new Date().toISOString() });
  }

  /**
   * 来信登记/校验（R-1 语义面——按 uuid 键形分派）：
   *   · 对键形（a~b）/裸身份键 → 键反演建立（键即权威，首封无毒化）；
   *   · UUIDv7 形等其他键形 → 首见 [sender, to]（对话两端——uuid 为发送方
   *     签发的会话身份键，A3「双方互发首条」语义下两端即名册）；
   *   · 机制域 sender（host/@ 群地址）首见 **defer 不登记**（回执先于真实
   *     首信到达时无名册可建——放行且不留毒化面，条目由首个真实对话信建立），
   *     已登记则恒放行（机制信投递语义，非会话发言）；
   *   · hit → sender 名册成员判定，集外 fail-loud（防身份冒用）。
   */
  register(uuid: string, sender: string, to?: string): RegisterResult {
    if (uuid.length === 0) throw new Error('uuid 不得为空');
    const existing = this.byUuid.get(uuid);
    if (existing === undefined) {
      if (isMechanismEndpointId(sender)) return { kind: 'consistent' }; // defer：机制回投不建名册
      const roster = participantsOfKey(uuid)
        ?? (to !== undefined && to !== '' ? [sender, to] : [sender]);
      const entry: ConversationEntry = { uuid, participants: [...new Set(roster)].sort(), firstSeenAt: new Date().toISOString() };
      this.byUuid.set(uuid, entry);
      return { kind: 'registered', entry };
    }
    if (isMechanismEndpointId(sender)) return { kind: 'consistent' }; // 机制域回投：非会话发言
    return existing.participants.includes(sender)
      ? { kind: 'consistent' }
      : { kind: 'conflict', registered: existing, incoming: [sender] };
  }

  lookup(uuid: string): ConversationEntry | undefined {
    return this.byUuid.get(uuid);
  }
}

/** 端点可达表（在场轴——guardian adopt 登记，心跳维持，崩溃摘除） */
export class ReachabilityTable {
  private readonly endpoints = new Map<string, { transportHint: string; since: string }>();

  markReachable(endpointId: string, transportHint: string): void {
    this.endpoints.set(endpointId, { transportHint, since: new Date().toISOString() });
  }

  markGone(endpointId: string): void {
    this.endpoints.delete(endpointId);
  }

  /** 可达提示（投递路由用）；不可达 = undefined → 发件箱滞留 */
  hintFor(endpointId: string): string | undefined {
    return this.endpoints.get(endpointId)?.transportHint;
  }

}
