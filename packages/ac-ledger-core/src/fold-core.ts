// ============================================================
// fold-core.ts —— 会话折叠纯核（cr-1245 B1 自 ac-ledger fold.ts 拆入）
//
// 解释权单源的纯半边：SessionFold 合并模型（facts 合入——fs 枚举归
// ac-ledger foldSession 壳）、压缩边界谓词族（rowShadowedBy/foldSummaryOf/
// foldDigestOf）、步投影（foldStepsOf）、user 终稿层投影（foldUserReplay）、
// 子调用卡注入（injectSubcallCards）。零 fs 零 cordis。
// ============================================================
import { injectSubcallCards } from './reader-core.ts';
import type { DomainFacts, RunFactsV2, SpeechEvent, ContextEvent, CompactionFacts } from './events-core.ts';
import type { JournalToolResult, ProjectedStep } from './records.ts';
import type { UserReplayRow } from './user-core.ts';

// —— steps 重建（相位事件 → ProjectedStep；聚合轨迹直通） ——

interface StepAcc {
  order: number;
  content: string[];
  reasoning: string[];
  reasoningMs?: number;
  textMs?: number;
  calls: Array<{ id: string; name: string; arguments: string }>;
  firstContentAt?: number;
  firstCallAt?: number;
  meter?: StepMeter;
  stepId?: string;
  firstTs?: number;
  firstSeq?: number;
}
import type { StepMeter } from './events-core.ts';

/** run 步投影（v1 stepsOfRun/stepsOfLedger 的 fold 统一形态） */
export function foldStepsOf(f: RunFactsV2, subcalls: JournalToolResult[]): { steps: ProjectedStep[]; partial: boolean } | null {
  // 聚合轨迹优先（v1 物化段行——journal 收束即清后的 steps 事实源）
  if (f.aggregated !== undefined) {
    const steps = f.aggregated.map((s) => ({ ...s, ...(s.toolCalls !== undefined ? { toolCalls: s.toolCalls.map((tc) => ({ ...tc })) } : {}) }));
    injectSubcallCards(steps, subcalls);
    return { steps, partial: false };
  }
  const results = new Map<string, { ok: boolean; output?: unknown; error?: string }>();
  const durations = new Map<string, number>();
  const subcallKids: Array<{ toolCallId: string; name?: string; arguments?: string; result: unknown; seq?: number }> = [];
  const acc = new Map<number, StepAcc>();
  let order = 0;
  for (const ev of f.events) {
    if (ev.kind === 'inject') continue;
    if (ev.kind === 'tool-call-result') {
      results.set(ev.toolCallId, ev.result);
      if (ev.durationMs !== undefined) durations.set(ev.toolCallId, ev.durationMs);
      if (ev.subcall === true) subcallKids.push({ toolCallId: ev.toolCallId, ...(ev.name !== undefined ? { name: ev.name } : {}), ...(ev.arguments !== undefined ? { arguments: ev.arguments } : {}), result: ev.result, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) });
      continue;
    }
    const meter = f.meters.get(ev.step);
    let s = acc.get(ev.step);
    if (s === undefined) {
      s = { order: order++, content: [], reasoning: [], calls: [], ...(meter !== undefined ? { meter } : {}), ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}), firstTs: ev.ts, ...(ev.seq !== undefined ? { firstSeq: ev.seq } : {}) };
      acc.set(ev.step, s);
    }
    if (meter !== undefined) s.meter = meter;
    if (ev.stepId !== undefined && s.stepId === undefined) s.stepId = ev.stepId;
    if (ev.kind === 'reasoning') {
      s.reasoning.push(ev.text);
      if (ev.reasoningMs !== undefined) s.reasoningMs = ev.reasoningMs;
    } else if (ev.kind === 'content') {
      s.content.push(ev.text);
      if (s.firstContentAt === undefined) s.firstContentAt = ev.seq ?? ev.ts;
    } else {
      s.calls.push({ id: ev.toolCallId, name: ev.name, arguments: ev.arguments });
      if (s.firstCallAt === undefined) s.firstCallAt = ev.seq ?? ev.ts;
    }
  }
  if (acc.size === 0) return null;
  // 子调用按宿主卡分组（宿主 toolCallId 首段——runFacts 同款）
  const kidsByHost = new Map<string, typeof subcallKids>();
  for (const k of subcallKids) {
    const hash = k.toolCallId.indexOf('#');
    if (hash <= 0) continue;
    const host = k.toolCallId.slice(0, hash);
    const bucket = kidsByHost.get(host);
    if (bucket !== undefined) bucket.push(k);
    else kidsByHost.set(host, [k]);
  }
  const finish = f.end?.finish;
  const steps: ProjectedStep[] = [...acc.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([stepNum, s]) => {
      void stepNum;
      const content = s.content.join('');
      const reasoning = s.reasoning.join('');
      const calls = s.calls.map((tc) => {
        // 中止/错误步同判（cr-1042）：aborted = 流不完整（中止或中途失败），
        // 调用从未开始；interrupted/error 收束下的完整步 = 结果未知
        const synth = finish !== undefined && finish !== 'completed'
          ? (s.meter?.aborted === true ? { ok: false, error: 'TOOL_NOT_STARTED' } : { ok: false, error: 'TOOL_OUTCOME_UNKNOWN' })
          : { ok: true };
        const result = results.get(tc.id) ?? (f.end !== undefined ? synth : null);
        const dur = durations.get(tc.id);
        const hostCard: { id: string; name: string; arguments: string; result: unknown; subcall?: boolean; durationMs?: number } = { id: tc.id, name: tc.name, arguments: tc.arguments, result, ...(dur !== undefined ? { durationMs: dur } : {}) };
        const kids = kidsByHost.get(tc.id);
        if (kids === undefined) return [hostCard];
        kids.sort((a, b) => (a.seq ?? idTailSeq(a.toolCallId)) - (b.seq ?? idTailSeq(b.toolCallId)));
        return [hostCard, ...kids.map((k) => ({ id: k.toolCallId, name: k.name ?? '(unknown)', arguments: k.arguments ?? '{}', result: k.result, subcall: true as const }))];
      }).flat();
      return {
        content,
        ...(s.stepId !== undefined ? { stepId: s.stepId } : {}),
        ...(s.firstTs !== undefined ? { ts: s.firstTs } : {}),
        ...(s.firstSeq !== undefined ? { seq: s.firstSeq } : {}),
        ...(reasoning !== '' ? { reasoning } : {}),
        // 步内相位序（cr-946 渲染契约保留；v2 起 = 事件序推导，字段退役于写面）
        ...(s.firstContentAt !== undefined && s.firstCallAt !== undefined && s.firstContentAt < s.firstCallAt ? { textBeforeTools: true } : {}),
        ...(s.meter?.aborted === true ? { aborted: true } : {}),
        ...(s.reasoningMs !== undefined ? { reasoningMs: s.reasoningMs } : {}),
        ...(s.meter?.textMs !== undefined ? { textMs: s.meter.textMs } : {}),
        ...(s.meter?.elapsedMs !== undefined ? { elapsedMs: s.meter.elapsedMs } : {}),
        ...(s.meter?.usage !== undefined ? { usage: s.meter.usage } : {}),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      } satisfies ProjectedStep;
    });
  return { steps, partial: f.end === undefined };
}

function idTailSeq(toolCallId: string): number {
  const hash = toolCallId.lastIndexOf('#');
  const tail = hash > 0 ? Number(toolCallId.slice(hash + 1)) : NaN;
  return Number.isFinite(tail) ? tail : 0;
}

// —— 会话折叠模型 ——

/** 跨域合并的会话折叠模型（fold 单源的中间形态） */
export interface SessionFold {
  domains: string[];
  /** 域 → 事实（未合并面） */
  factsOf: Map<string, DomainFacts>;
  speech: SpeechEvent[];
  contexts: ContextEvent[];
  /** run → 事实（对桶 participants 并域合并——run 键不相交无重） */
  runs: Map<string, RunFactsV2 & { domain: string }>;
  version: number;
  /** 最新压缩事实（多域取边界最大者——对桶跨域压缩的保守归并；兼容面） */
  compaction?: CompactionFacts;
  /** 全部压缩代（cr-1160 P2：多轮边界叠加——按域并入，代序 = 各域入列序；
   *  rowShadowedBy 谓词的事实源） */
  compactions: CompactionFacts[];
}

/**
 * facts 合入 fold（cr-1245 B1 自 foldSession 抽纯核——fs 枚举归 ac-ledger
 * foldSession 壳：shell 传 [dir] 单域，宿主传 conversationDirs 全域序）。
 */
export function foldFromFacts(fold: SessionFold, facts: DomainFacts): void {
  const domain = facts.domain;
  if (domain === 'viewer') return;
  fold.domains.push(domain);
  fold.factsOf.set(domain, facts);
  fold.version = Math.max(fold.version, facts.version);
  fold.compactions.push(...facts.compactions);
  if (facts.compaction !== undefined
    && (fold.compaction === undefined || facts.compaction.boundarySeq > fold.compaction.boundarySeq)) {
    fold.compaction = facts.compaction;
  }
  fold.speech.push(...facts.speech);
  fold.contexts.push(...facts.contexts);
  for (const [run, rf] of facts.runs) fold.runs.set(run, { ...rf, domain });
}

/** 空 fold（foldSession 壳的初始形态——cr-1245 B1 参数化） */
export function emptyFold(): SessionFold {
  return { domains: [], factsOf: new Map(), speech: [], contexts: [], runs: new Map(), version: 1, compactions: [] };
}

/**
 * 行是否被压缩边界 shadow（cr-1160 P2 三级裁决谓词——单源）：
 *  ⓪ 时刻放行前置（cr-1156 不变量）：行落账时刻晚于压缩收束时刻 → 恒 kept
 *    （物理重写后 writer 重启小 seq 空间，seq 比较只对事件前 shadowed 前缀
 *    负责；位置维判定前先放行事件后落账行——admin~user 现场形态）；
 *  ① 位置维（行有 seq）：seq ≤ boundarySeq → shadowed；
 *  ② 时刻维（行无 seq、行有数字 ts）：ts ≤ endTs → shadowed；
 *  ③ 文件位置维（v1 无 seq 无数字 ts 行的兜底）：调用方已知该行在文件中
 *     出现于 compaction 事件行之前（beforeEvent = true）→ shadowed；
 *     未给 → kept（保守放行——与既有口径等价）。 */
export function rowShadowedBy(
  row: { seq?: number; ts?: number },
  boundary: { boundarySeq: number; endTs: number },
  beforeEvent?: boolean,
): boolean {
  if (typeof row.ts === 'number' && boundary.endTs > 0 && row.ts > boundary.endTs) return false;
  if (typeof row.seq === 'number') return row.seq <= boundary.boundarySeq;
  if (typeof row.ts === 'number' && boundary.endTs > 0) return row.ts <= boundary.endTs;
  return beforeEvent === true;
}

/** V3 归档摘要行 source 词（cr-1189）——archive-summary context 行判别键 */
export const ARCHIVE_SUMMARY_SOURCE = 'archive-summary';

/**
 * 会话最新摘要文本（cr-1189 V3 单一事实源）：最新未被任一压缩代
 * shadow 的 archive-summary 行；全部 shadow / 无行 → null（调用方回落
 * foldSummaryOf〔v2 存量代〕或 summaryTextOf〔v1 存量〕）。
 * 摘要行落在自身代边界之后（落账序：压缩轮事实 → 摘要行 → compaction
 * 事件），本轮永不被 shadow；下轮压缩把它划入旧代——新一代摘要行接替。
 */
export function foldDigestOf(fold: SessionFold): string | null {
  let best: { text: string; at: string } | null = null;
  for (const c of fold.contexts) {
    if (c.source !== ARCHIVE_SUMMARY_SOURCE || c.content.trim() === '') continue;
    const tsNum = Date.parse(c.timestamp);
    const shadowed = fold.compactions.some((b) => rowShadowedBy(
      { ...(c.seq !== undefined ? { seq: c.seq } : {}), ...(Number.isFinite(tsNum) ? { ts: tsNum } : {}) },
      b,
    ));
    if (shadowed) continue;
    if (best === null || c.timestamp >= best.at) best = { text: c.content, at: c.timestamp };
  }
  return best?.text ?? null;
}

// —— 投影一：user 终稿层（projectUserReplay 谓词原样） ——

export function foldUserReplay(fold: SessionFold): UserReplayRow[] {
  const out: Array<UserReplayRow & { ord: number }> = [];
  const seen = new Set<string>();
  const runsWithFinal = new Set<string>();
  for (const r of fold.speech) {
    if (r.agentId !== 'user') continue;
    // cr-1309：cr-946 前 speech 落形的 restarted-* 通知行已全量归一 context+event
    //（normalize-restarted-rows.mjs）——读侧滤除分支退役。
    // cr-1132:去重键缺席(手写夹具/极端存量的 undefined/空串)不互吞——
    // 此前 seen.add(缺值) 会把后续全部无 id 行互吞
    if (r.messageId && seen.has(r.requestId ?? r.messageId)) continue;
    if (r.requestId !== undefined) seen.add(r.requestId);
    if (r.messageId) seen.add(r.messageId);
    // cr-1286 P4-1：messageId 透出（user 行同款升格——主投影 turnId 打点源；
    // 亦使 ViewRow.message_id 与 peer 行对齐，anchor 派生受益同源）
    out.push({ role: 'user', agentId: 'user', content: r.content, ...(r.requestId !== undefined ? { requestId: r.requestId } : {}), timestamp: r.timestamp, ...(r.seq !== undefined ? { seq: r.seq } : {}), ...(r.messageId ? { messageId: r.messageId } : {}), ...(r.delivered !== undefined ? { delivered: r.delivered } : {}), ord: out.length });
  }
  // cr-1344（user 域对称化）第二循环两遍：先 user 域 agent 行（入站行
  // agent_id=sender——user 收到的投递事实，同键去重优先于 sender 域的
  // 出站/settle 行——出站行已退役，此处兜存量迁移窗与 settle 同键并发），
  // 再 agent 域自著行（原谓词 agent_id=domain——终稿/通知）。user 域行
  // 不剔空文本（run 键行语义——错误收束空回信是 user 的既得事实，cr-628；
  // IM 档空正文由 imStripSteps 自然滤）。
  const pushPeer = (r: SpeechEvent): void => {
    if (r.agentId === 'user') return; // user 行（通知行已归一 context——fold.speech 内不再混入）
    if (r.messageId && seen.has(r.requestId ?? r.messageId)) return;
    const run = r.run ?? r.sourceRun;
    if (run !== undefined && runsWithFinal.has(run)) return;
    if (r.requestId !== undefined) seen.add(r.requestId);
    if (r.messageId) seen.add(r.messageId);
    if (run !== undefined) runsWithFinal.add(run);
    // cr-1132:messageId 透出——主投影发言行升格携带 message_id(anchor 派生
    // 的锚目标;前端按 persistedMsgId 对锚,分支/删除按钮随锚亮起为正向收编)
    out.push({ role: 'peer', agentId: r.agentId, content: r.content, ...(run !== undefined ? { run } : {}), ...(r.runMs !== undefined ? { runMs: r.runMs } : {}), ...(r.requestId !== undefined ? { requestId: r.requestId } : {}), timestamp: r.timestamp, ...(r.seq !== undefined ? { seq: r.seq } : {}), ...(r.messageId ? { messageId: r.messageId } : {}), ...(r.delivered !== undefined ? { delivered: r.delivered } : {}), ord: out.length });
  };
  for (const r of fold.speech) {
    if (r.domain !== 'user') continue;
    pushPeer(r);
  }
  for (const r of fold.speech) {
    if (r.domain === 'user') continue;
    if (r.content.trim() === '') continue;
    pushPeer(r);
  }
  // 排序事实键 = 时间戳（cr-716；稳定：同刻 user 先于 peer——收集序）
  return out
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.ord - b.ord))
    .map(({ ord: _ord, ...row }) => { void _ord; return row; });
}

// —— 会话文本回放（轻量视图——foldTextReplay 语义） ——

/** 文本投影（viewer 视角 role 变换；空 content/段行/注入行不入——归一化已滤） */
export function foldTextReplay(fold: SessionFold, viewer: string): Array<{ role: 'assistant' | 'user'; content: string }> {
  return fold.speech
    .filter((r) => r.content.trim() !== '')
    .map((r) => ({ role: r.agentId === viewer ? 'assistant' as const : 'user' as const, content: r.content }));
}
