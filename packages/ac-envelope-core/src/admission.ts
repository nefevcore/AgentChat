// ============================================================
// admission.ts —— requestId 幂等准入器（cr-250 语义，协议规格 A2）
//
// 接收方收到信封 → requestId 入准入表（内存）；同键重发 = 去重（重复
// 即丢 + 补发 ack）。容量语义与现状先例同源：Set 保插入序 = FIFO 淘汰
// 序，上限 200（SEEN_REQUESTS_MAX 平移）。持久化钩子注入（缺省无——
// M3 壳 ledger 接跨重启语义时接 .deliver-seen.json 同形文件）。
// ============================================================

/** 准入表容量上限（FIFO 淘汰；现状先例 SEEN_REQUESTS_MAX = 200 平移） */
export const ADMISSION_MAX = 200;

/** 持久化钩子（fail-open：失败告警不阻塞准入——与现状先例一致） */
export interface AdmissionPersistence {
  /** 受理集变更后回调（全量数组，插入序） */
  persist(admitted: string[]): void;
}

export class AdmissionGate {
  private readonly seen = new Set<string>();
  private readonly capacity: number;
  private readonly persistence: AdmissionPersistence | undefined;
  constructor(capacity: number = ADMISSION_MAX, persistence?: AdmissionPersistence) {
    this.capacity = capacity;
    this.persistence = persistence;
  }

  /** 从持久面恢复（构造后调用；不触发 persist 回调） */
  restore(admitted: string[]): void {
    for (const id of admitted) this.seen.add(id);
    this.trim();
  }

  /** 幂等键短路判定 + 受理登记：先查后登记，命中返回 false 不重复登记 */
  admit(requestId: string): boolean {
    if (this.seen.has(requestId)) return false;
    this.seen.add(requestId);
    this.trim();
    this.persistence?.persist([...this.seen]);
    return true;
  }

  /** 当前受理集快照（诊断/持久化面） */
  snapshot(): string[] {
    return [...this.seen];
  }

  private trim(): void {
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
