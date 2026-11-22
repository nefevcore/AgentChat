// ============================================================
// doctor.ts —— ledger doctor 纯核（cr-1245 B4）
//
// 账本不变量校验器：逐会话重算 fold 对拍落盘主张（compaction stats /
// 索引 est_tokens）+ seq 合法性扫描 + 文法未知词报告。doctor 是审计层
// ——架构（单源投影/验证转移）让未来违例不可表达，doctor 管存量债与
// 实现自身 bug。
// severity 词汇（B6）：info 观测 / warn 偏差待归因 / error 不变量失守。
// 零 fs——输入 = 归一化事实（DomainFacts）+ 行流；CLI 壳负责枚举。
// ============================================================
import type { DomainFacts } from './events-core.ts';
import type { LedgerRow } from './records.ts';
import { foldFromFacts, emptyFold, type SessionFold } from './fold-core.ts';

/** 违例严重度（与迁移链校验器共享词汇——cr-1036 轻共基座） */
export type DoctorSeverity = 'info' | 'warn' | 'error';

/** 单条违例（报告结构化——session × invariant × severity × 行锚） */
export interface DoctorFinding {
  invariant: 'seq-space' | 'grammar' | 'claim' | 'digest';
  severity: DoctorSeverity;
  anchor?: number;
  message: string;
}

/**
 * INV1 seq 合法性（cr-1156/1234 族）：洞合法（tailMaxSeq 窗口 miss、
 * 压缩重写后小 seq 空间），**回退可疑**——同文件内 seq 先增后减
 * 且无压缩代边界解释 = 报 warn（行落账时刻晚于代收束 = 重写窗口放行）。
 * v1 无 seq 行不参与。
 */
export function scanSeqSpace(rows: LedgerRow[], facts: DomainFacts): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  let max = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as { seq?: unknown; ts?: unknown; timestamp?: unknown };
    if (typeof r.seq !== 'number' || !Number.isFinite(r.seq)) continue;
    const rowTs = typeof r.ts === 'number' ? r.ts : (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN);
    if (r.seq < max) {
      const inRewriteWindow = facts.compactions.some((c) => Number.isFinite(rowTs) && c.endTs > 0 && rowTs > c.endTs);
      if (!inRewriteWindow) {
        out.push({ invariant: 'seq-space', severity: 'warn', anchor: r.seq, message: 'seq 回退（第 ' + (i + 1) + ' 行 seq=' + r.seq + ' < 已见 max=' + max + '，无压缩代重写窗口解释）' });
      }
    }
    if (r.seq > max) max = r.seq;
  }
  return out;
}
/**
 * INV2 文法未知词（info 级）：v2 type 词表外的行——安全忽略是文法
 * 条款，但未知词落盘值得观测（check-replay-vocab watchdog 的 doctor 面）。
 */
const V2_KNOWN = new Set(['message', 'context', 'step/reasoning', 'step/content', 'step/tool-call', 'step/tool-call-result', 'inject', 'run-end', 'compaction', 'compaction/start', 'compaction/summary', 'compaction/end', 'session-header']);
export function scanGrammar(rows: LedgerRow[]): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const seen = new Map<string, number>();
  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    if (r.type !== undefined && !V2_KNOWN.has(String(r.type))) {
      const word = String(r.type);
      seen.set(word, (seen.get(word) ?? 0) + 1);
    }
  }
  for (const [word, count] of seen) {
    out.push({ invariant: 'grammar', severity: 'info', message: '未知 type 词 ' + word + ' × ' + count + '（安全忽略——词表登记面）' });
  }
  return out;
}

/**
 * INV3 主张对拍（cr-1214/1229 族核心）：compaction 事件携带的
 * stats.estimatedTokens 是「关于 fold 的主张」——重算回放口径对拍。
 * 重算函数由调用方注入（CLI 组合 replayTokensFor；core 不依赖
 * archive-core——依赖方向 archive-core → core 不反向）。
 * 阈值 = max(claimed × 2, 10_000)：主张是压缩时刻快照，与当前的差
 * 是压缩后新内容增量；超阈 = 计量管线违例信号（error）。
 */
export function scanClaims(
  facts: DomainFacts,
  recompute: { activeTokens: () => number },
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const c of facts.compactions) {
    if (c.stats?.estimatedTokens === undefined) continue;
    const actual = recompute.activeTokens();
    const claimed = c.stats.estimatedTokens;
    const drift = Math.abs(actual - claimed);
    if (drift > Math.max(claimed * 2, 10_000)) {
      out.push({ invariant: 'claim', severity: 'error', message: 'compaction(' + c.run + ') stats.estimatedTokens=' + claimed + ' vs 重算 ' + actual + '（偏差 ' + drift + ' 超阈——计量管线违例信号）' });
    }
  }
  return out;
}

/** 单域全量校验（CLI 壳逐会话调用） */
export function doctorScan(
  rows: LedgerRow[],
  facts: DomainFacts,
  recompute: { activeTokens: () => number },
): DoctorFinding[] {
  return [
    ...scanSeqSpace(rows, facts),
    ...scanGrammar(rows),
    ...scanClaims(facts, recompute),
  ];
}

/** fold 级便捷构造（doctor 壳用：facts → fold 供摘要检查） */
export function foldOfFacts(facts: DomainFacts): SessionFold {
  const fold = emptyFold();
  foldFromFacts(fold, facts);
  return fold;
}
