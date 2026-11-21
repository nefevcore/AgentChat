// ============================================================
// service.ts —— sessionIndex 服务行面（cr-973 Phase 1，2026-11-09）
//
// cordis 行装配面：纯库 SessionIndex（core.ts）挂上 ctx.sessionIndex
// 插槽（读面消费方 inject；行可摘——摘掉即读面回落全扫投影，方案
// §1.3 插槽-插头验收）。DB 落 <dataRoot>/index/session-index.db
//（宿主单写者）；句柄随行卸载回收（ctx.effect 反序 disposer——
// 注册即归属，cordis 代管）。工厂形态照 ac-ledger makeLedgerRow。
// ============================================================
import * as path from 'node:path';
import { Service, type Context, type Plugin } from '@agentchat/cordis';
import { SessionIndex, type RefreshReport, type SessionMeta, type SessionKind, type RosterRow } from './core.ts';

export type { SessionMeta, SessionKind, RosterRow };

/** 行配置（boot 装配参数） */
export interface SessionIndexRowOptions {
  dataRoot: string;
  /** DB 落点覆盖（缺省 = <dataRoot>/index/session-index.db） */
  dbFile?: string;
}

export class SessionIndexService extends Service {
  private dataRoot: string;
  private index: SessionIndex;

  constructor(ctx: Context, options: SessionIndexRowOptions) {
    super(ctx, 'sessionIndex');
    this.dataRoot = options.dataRoot;
    this.index = new SessionIndex(options.dbFile ?? path.join(options.dataRoot, 'index', 'session-index.db'));
    // db 句柄随宿主行卸载回收（effect disposer 与行同生命周期）
    ctx.effect(() => () => this.index.close());
  }

  /** 惰性刷新某会话指针行（对账语义见 core.ts 文件头） */
  refresh(convId: string): RefreshReport {
    return this.index.refreshConversation(this.dataRoot, convId);
  }

  /** 视图指纹 + agent 域集（historyView 同公式跨互认） */
  fingerprintOf(convId: string): { fingerprint: string; domains: string[] } {
    return this.index.fingerprintOf(this.dataRoot, convId);
  }

  /** stat 面入账 + 账面聚合 + 清账（runs/snapshot 指纹源——cr-980） */
  refreshStats(convId: string): void {
    this.index.refreshStats(this.dataRoot, convId);
  }

  catalog(): Array<{ conv: string; size: number; mtimeMs: number }> {
    return this.index.catalog();
  }

  /** messages.jsonl 账面（singles/list 指纹复验源——cr-981） */
  messagesCatalog(): Array<{ conv: string; size: number; mtimeMs: number }> {
    return this.index.messagesCatalog();
  }

  drop(convId: string): void {
    this.index.drop(convId);
  }

  /** 会话元数据聚合（cr-1138）：records 表 SQL 统计，零盘读。
   *  opts.refresh=false = 只读聚合（cr-1142：高频面用——不建索引，未入账
   *  会话返回 null；索引仍由 RPC/historyView 等显式读面按需建立） */
  sessionMeta(convId: string, opts: { refresh?: boolean } = {}): SessionMeta | null {
    return this.index.sessionMeta(this.dataRoot, convId, opts);
  }

  /** 名册缺口判定（cr-1185；性能修复后单会话原子——全量对账由调用方
   *  分片让出，见 face-ops warmRoster） */
  rosterGapOf(convId: string): boolean {
    return this.index.rosterGapOf(this.dataRoot, convId);
  }

  /** 全部会话键枚举（分片全量对账的数据源——零 stat） */
  allConversationIds(): string[] {
    return this.index.allConversationIds(this.dataRoot);
  }

  /** 名册小表快照（cr-1185——零盘读；群行已由成员流折叠） */
  rosterSnapshot(): RosterRow[] {
    return this.index.rosterSnapshot();
  }

  /** 日聚合（cr-1138）：单会话权威（带 refresh）/ 全局已索引子集
   *（coverage 报覆盖度；full = 显式预热全量对账） */
  sessionByDay(
    convId?: string,
    full = false,
  ): { days: Array<{ day: string; total: number; speech: number }>; coverage: { indexedConversations: number; totalConversations: number } } {
    return this.index.sessionByDay(this.dataRoot, convId, full);
  }

  /** 压缩代清单（cr-1160 P4）——core.compactionFactsOf 透传 */
  compactionFactsOf(convId: string): Array<{ domain: string; run: string; generation: number; boundarySeq: number; endTs: number; summaryLen: number | null; summaryTokens: number | null; model: string | null; stats: { shadowedRows?: number; estimatedTokens?: number } | null }> {
    return this.index.compactionFactsOf(this.dataRoot, convId);
  }

  /** 活跃上下文估算合计（cr-1160 P4）——core.activeContextTokens 透传 */
  activeContextTokens(convId: string, opts: { refresh?: boolean } = {}): number | null {
    return this.index.activeContextTokens(this.dataRoot, convId, opts);
  }

  /** 某 run 的子调用行（缺席 = []; 未入账 = undefined 回落全量读） */
  subcallLines(convId: string, domain: string, run: string): Array<Record<string, unknown>> | undefined {
    return this.index.subcallLines(this.dataRoot, convId, domain, run);
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 会话指针索引服务（宿主 sessionIndex 行提供——纯缓存，可全量重建） */
    sessionIndex: SessionIndexService;
  }
}

/** sessionIndex 行工厂（boot rowAssemblers 装配——数据根/DB 落点显式注入） */
export function makeSessionIndexRow(options: SessionIndexRowOptions): Plugin {
  return {
    name: 'ac-session-index/row',
    inject: [],
    apply(ctx: Context) {
      ctx.plugin(class extends SessionIndexService {
        constructor(c: Context) { super(c, options); }
      });
    },
  } satisfies Plugin;
}
