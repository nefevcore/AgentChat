// ============================================================
// events.ts —— source 采集域事件目录（cr-1165）
//
// 谁提供本域谁声明（契约归属 owning package）：本包承载采集行
// （fs-source）与物化契约——source/updated 由采集行在每次物化后
// emit（一次物化一个事件——批量，不逐行），timers 行订阅分发。
// ============================================================

/** source/updated 载荷 */
export interface SourceUpdatedPayload {
  /** 源名（物化目录 exports/<source>/） */
  source: string;
  /** 视图名（ACL 粒度——哪个 Agent 看哪些行是行配置策略） */
  view: string;
  /** 本次物化终态 seq */
  seq: number;
}

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 源物化完成（纯通知——采集行 → 触发层）。
     *
     * @mode emit
     * @scope host（物化发生在宿主采集行，不属任何 Agent 的执行）
     * @param payload { source, view, seq }——消费方（timers 行）按
     *   自家订阅表过滤并读物化面增量（readRowsSince）
     */
    'source/updated'(payload: SourceUpdatedPayload): void;
  }
}
