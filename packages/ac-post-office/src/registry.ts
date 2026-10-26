// ============================================================
// registry.ts —— 邮局登记面（R-1 uuid 签发权 + 在场可达表）
//
// uuid = 会话出生证明（发送方签发，第一条记录写在发送方账本）；
// 邮局角色 = 登记 / 一致性校验：首次见 (uuid, participants) 登记，
// 再见校验，不一致 fail-loud（防身份冒用）。纯直连期间双方账本
// 各自为真，邮局在场时对账。
// 在场可达表：endpointId → transportHint（guardian adopt 时登记——
// 壳 boot.ready 携带 hint，宿主标记可达）。
// ============================================================

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

/** uuid 登记表（内存——邮局会话期状态；持久化随 M5+ 按需） */
export class ConversationRegistry {
  private readonly byUuid = new Map<string, ConversationEntry>();

  /** 登记或校验（R-1 一致性——集合比较，与序无关） */
  register(uuid: string, participants: string[]): RegisterResult {
    if (uuid.length === 0) throw new Error('uuid 不得为空');
    const norm = [...new Set(participants)].sort();
    const existing = this.byUuid.get(uuid);
    if (existing === undefined) {
      const entry: ConversationEntry = {
        uuid,
        participants: norm,
        firstSeenAt: new Date().toISOString(),
      };
      this.byUuid.set(uuid, entry);
      return { kind: 'registered', entry };
    }
    const same = existing.participants.length === norm.length
      && existing.participants.every((p, i) => p === norm[i]);
    if (same) return { kind: 'consistent' };
    // 子集一致（cr-576 群会话）：来信端点全部已在登记集内 = 同一群成员流的
    // 另一参与方发言/回信——consistent。conflict 只拦集外端点（真冒用）。
    // 群成员流（gid~member 形 uuid）由群行预登记全名册，多发送方天然子集。
    const within = norm.every((p) => existing.participants.includes(p));
    return within
      ? { kind: 'consistent' }
      : { kind: 'conflict', registered: existing, incoming: norm };
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

  reachable(): string[] {
    return [...this.endpoints.keys()].sort();
  }
}
