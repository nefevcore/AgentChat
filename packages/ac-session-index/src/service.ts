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
import { SessionIndex, type RefreshReport } from './core.ts';

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
