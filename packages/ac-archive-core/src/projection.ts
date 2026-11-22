// ============================================================
// projection.ts —— 回放口径投影单源（cr-1245 B2）
//
// 计量 = 回放口径的构造性统一：shadow 过滤（rowShadowedBy）+ 伪行合成
//（v2 事件行 → v1 段行同形——估算器只见 role 行）+ 摘要头选择（digest
// 单源 → v2 存量代 → v1 兼容窗），此前 ac-shell-rows estimateOf 与
// ac-host-webui replayTokensOf 两份管线靠「同型」注释同步（cr-1245b
// 活案例——cr-1214/1229 的管线级走散根因面）。本文件是唯一实现；
// 消费方只传 facts 与目录编排参数。
// 依赖方向：ac-archive-core → ac-ledger-core（纯库 → 纯库）。
// ============================================================
import { estimateReplayTokens, type ArchiveMessage } from './index.ts';
import { rowShadowedBy, foldStepsOf, foldDigestOf, foldSummaryOf, type SessionFold, type DomainFacts, type CompactionFacts } from 'ac-ledger-core';
import type { LedgerRow, ProjectedStep } from 'ac-ledger-core';

/**
 * 伪行合成输入：v2 会话步级事实 = 事件行（无 role——估算器只见 role 行），
 * 折叠出 steps 合成 v1 段行同形伪行。版本判据 = 行面而非头行（cr-1214：
 * 混合会话头行 version=1 永不重写，行面已是 v2 事件行——按头行守门让
 * 伪行整代缺席，实测 12.7 万 vs 真实 105 万）。
 */
export function hasV2RowFace(rows: LedgerRow[]): boolean {
  return (rows as unknown as Array<Record<string, unknown>>).some(
    (r) => r.type !== undefined || r.seq !== undefined,
  );
}

/** 行时刻（v2 事件行数字 ts / v1 行 ISO timestamp——索引与估算同谓词） */
export function rowTsOf(r: { ts?: unknown; timestamp?: unknown }): number | undefined {
  if (typeof r.ts === 'number' && Number.isFinite(r.ts)) return r.ts;
  if (typeof r.timestamp === 'string' && r.timestamp !== '') {
    const parsed = Date.parse(r.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * run 级 shadow 判定（与 foldLlmReplay orphan slot 同源）：末事实 seq +
 * 末 ts（步 ts 并入）——整 run 属压缩前代则伪行不计。
 */
export function runShadowedOf(rf: DomainFacts['runs'] extends Map<string, infer R> ? R : never, boundaries: CompactionFacts[]): boolean {
  if (boundaries.length === 0) return false;
  let runSeq: number | undefined;
  let runTs: number | undefined;
  for (const ev of rf.events) {
    if (ev.kind === 'tool-call-result') continue;
    if (ev.seq !== undefined && (runSeq === undefined || ev.seq > runSeq)) runSeq = ev.seq;
    if (ev.ts !== undefined && (runTs === undefined || ev.ts > runTs)) runTs = ev.ts;
  }
  for (const s of rf.aggregated ?? []) {
    if (typeof s.ts === 'number' && (runTs === undefined || s.ts > runTs)) runTs = s.ts;
  }
  return boundaries.some((b) => rowShadowedBy(
    { ...(runSeq !== undefined ? { seq: runSeq } : {}), ...(runTs !== undefined ? { ts: runTs } : {}) },
    b,
  ));
}

/**
 * 回放投影（shadow 过滤 + 伪行合成 + 摘要头选择——三段公共核）。
 * summaryHead：digest 单源（V3 摘要行）在场时其正文已在 picked 内，
 * 调用方传 null 防双计；否则 v2 存量代（foldSummaryOf）或调用方自备
 * 的 v1 兼容窗文本。
 */
export interface ReplayProjection {
  /** shadow 过滤后的真行（activeOnly=false 时 = 原样全量） */
  picked: LedgerRow[];
  /** v2 run 轨迹伪行（估算器消费——role=agent 空 content 带 steps） */
  pseudo: ArchiveMessage[];
  /** 概要头（estimateReplayTokens opts.summary 取值；null = 不计） */
  summary: string | null;
}

export function replayProjection(
  rows: LedgerRow[],
  facts: DomainFacts,
  foldSummary: string | null,
  opts: { activeOnly?: boolean; viewer: string } = { viewer: '' },
): ReplayProjection {
  const boundaries = opts.activeOnly === true ? facts.compactions : [];
  const shadowed = (seq: number | undefined, ts: number | undefined): boolean =>
    boundaries.some((b) => rowShadowedBy({ ...(seq !== undefined ? { seq } : {}), ...(ts !== undefined ? { ts } : {}) }, b));
  const pseudo: ArchiveMessage[] = [];
  if (facts.version >= 2 || hasV2RowFace(rows)) {
    for (const [run, rf] of facts.runs) {
      const steps = foldStepsOf(rf, facts.subcallArchive.filter((s) => s.run === run))?.steps ?? [];
      if (steps.length === 0) continue;
      if (boundaries.length > 0 && runShadowedOf(rf, boundaries)) continue;
      pseudo.push({ role: 'agent', content: '', agent_id: facts.domain, steps: steps as unknown as ArchiveMessage['steps'], message_id: 'v2-' + run });
    }
  }
  const picked = boundaries.length > 0
    ? rows.filter((r) => !shadowed(typeof r.seq === 'number' ? r.seq : undefined, rowTsOf(r)))
    : rows;
  return { picked, pseudo, summary: foldSummary };
}

/** 摘要头选择（digest 行单源 → v2 存量代 → null；v1 兼容窗文本由调用方兜底传入） */
export function replaySummaryHead(fold: SessionFold, v1Fallback: string): string | null {
  const digest = foldDigestOf(fold);
  if (digest !== null) return null; // digest 行正文已在 picked 内——头不再发防双计
  return foldSummaryOf(fold)?.text ?? (v1Fallback !== '' ? v1Fallback : null);
}

/** 计量组合口：投影 → 回放口径估算值（归档阈值/水位判断唯一口径） */
export function replayTokensFor(proj: ReplayProjection, viewer: string): number {
  return estimateReplayTokens(
    [...proj.picked, ...proj.pseudo] as ArchiveMessage[],
    viewer,
    proj.summary !== null && proj.summary !== '' ? { summary: proj.summary } : {},
  );
}
