// ============================================================
// session-chain.ts —— 会话格式迁移链 v1→v2 边（M-A cr-1270）
//
// messages.jsonl 形态链：v1 三文件（messages + journal + subcalls）→
// v2 单文件事件日志（头行 version:2）。边函数 = facts 往返恒等：
//   domainFactsOf 归一化（v1 输入）→ eventToV2Row 序列化 → 再归一化
//   （v2 输入）两次 facts 相等 ⇔ fold 四投影对旧文件与新文件输出恒等
//   （fold 是 facts 的确定函数）。序列化逆向对齐 v2RowToEvent 词汇——
//   写出的行再读回零信息损失。零 fs（执行器与升头落盘住 ac-ledger 壳，
//   M-B 工具消费本链）。文本行 seq 策略：恒等携带（v1 行原有 seq 保
//   身份锚）；相位行 stepId 缺席的旧步（cr-772 前）无 seq 时置 0 不带。
// cr-1307：v1 词形段行退役——边对 aggregated 聚合轨迹直产 v2 相位
//   事件行（segmentRowToPhaseRows——cr-1306 等价映射），往返判据从
//   facts 面升级为 foldStepsOf 投影恒等（aggregated/aggregated' 语义
//   在投影面收敛；events 面继续 canon 多重集）。
// ============================================================

import {
  type DomainFacts,
  type SessionEvent, type SpeechEvent, type ContextEvent, type PhaseEvent,
  type InjectEvent, type RunEndEvent,
} from './events-core.ts';
import { runChain, assertChainIntegrity, type MigrationEdge, type VersionedValue } from 'ac-migration-core';
import type { JournalToolResult, ProjectedStep } from './records.ts';
import { injectSubcallCards } from './reader-core.ts';
import { segmentRowToPhaseRows } from './segment-normalize.ts';
import { foldStepsOf } from './fold-core.ts';

/** 会话文件形态值（链上载荷） */
export interface SessionForm {
  /** 头行元数据（升头继承：createdAt/participants/kind + 附加键原样） */
  header: { createdAt: string; participants: string[]; kind: string; extra: Record<string, unknown> };
  /** 归一化事实（v1 输入 = 三源归一；恒等判据的比较面） */
  facts: DomainFacts;
  /** v2 行序列（边产物——M-B 工具的写盘面；v1 输入为空数组） */
  v2Rows: Array<Record<string, unknown>>;
  /** v1 侧附加文件原样携带（subcalls 档案——M-C 时转 .migrated） */
  subcallArchive: unknown[];
  /** 坏行报告（读侧撕裂/未知行——恒等携带，M-C 对账报告面） */
  badLines: string[];
}

/** 头行键白名单（白名单外全部进 header.extra 继承） */
const HEADER_KEYS = new Set(['type', 'version', 'createdAt', 'participants', 'kind']);

/** 头行拆解（v1 头 → 继承元数据 + extra） */
export function splitHeader(h: Record<string, unknown>): SessionForm['header'] {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HEADER_KEYS.has(k)) extra[k] = v;
  }
  return {
    createdAt: String(h.createdAt ?? ''),
    participants: Array.isArray(h.participants) ? h.participants.map(String) : [],
    kind: String(h.kind ?? ''),
    extra,
  };
}

/** v2 头行（升头：继承旧头全字段 + version:2 + migratedFrom:1） */
export function v2Header(header: SessionForm['header']): Record<string, unknown> {
  return {
    type: 'session-header',
    version: 2,
    ...(header.createdAt !== '' ? { createdAt: header.createdAt } : {}),
    participants: header.participants,
    ...(header.kind !== '' ? { kind: header.kind } : {}),
    ...header.extra,
    migratedFrom: 1,
  };
}

/** speech 事件 → v2 行（type:'message'——v2RowToEvent 'message' 分支逆） */
function speechRow(s: SpeechEvent): Record<string, unknown> {
  return {
    type: 'message',
    role: 'agent',
    content: s.content,
    message_id: s.messageId,
    timestamp: s.timestamp,
    agent_id: s.agentId,
    ...(s.requestId !== undefined ? { requestId: s.requestId } : {}),
    ...(s.run !== undefined ? { run: s.run } : {}),
    ...(s.runMs !== undefined ? { runMs: s.runMs } : {}),
    ...(s.seq !== undefined ? { seq: s.seq } : {}),
    ...(s.sourceRun !== undefined ? { source: 'run:' + s.sourceRun } : {}),
  };
}

/** context 事件 → v2 行（type:'context'） */
function contextRow(c: ContextEvent): Record<string, unknown> {
  return {
    type: 'context',
    role: 'context',
    content: c.content,
    message_id: c.messageId,
    timestamp: c.timestamp,
    agent_id: c.agentId,
    ...(c.source !== '' ? { source: c.source } : {}),
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.payload !== undefined ? { payload: c.payload } : {}),
    ...(c.run !== undefined ? { run: c.run } : {}),
    ...(c.requestId !== undefined ? { requestId: c.requestId } : {}),
    ...(c.injectSource !== undefined ? { injectSource: c.injectSource } : {}),
    ...(c.seq !== undefined ? { seq: c.seq } : {}),
  };
}

/** 相位/注入/收束事件 → v2 行（step/* 家族 + inject + run-end）；
 *  压缩族不在此面（压缩代段独立重放）——调用方 eventToV2Row 先行分流。 */
function phaseRow(ev: PhaseEvent | InjectEvent | RunEndEvent): Record<string, unknown> | null {
  switch (ev.kind) {
    case 'reasoning':
      return { type: 'step/reasoning', run: ev.run, step: ev.step, ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}), text: ev.text, ...(ev.reasoningMs !== undefined ? { reasoningMs: ev.reasoningMs } : {}), ts: ev.ts ?? 0, ...(ev.usage !== undefined ? { usage: ev.usage } : {}), ...(ev.elapsedMs !== undefined ? { elapsedMs: ev.elapsedMs } : {}), ...(ev.aborted !== undefined ? { aborted: ev.aborted } : {}), ...(ev.textMs !== undefined ? { textMs: ev.textMs } : {}), ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };
    case 'content':
      return { type: 'step/content', run: ev.run, step: ev.step, ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}), text: ev.text, ts: ev.ts ?? 0, ...(ev.usage !== undefined ? { usage: ev.usage } : {}), ...(ev.elapsedMs !== undefined ? { elapsedMs: ev.elapsedMs } : {}), ...(ev.aborted !== undefined ? { aborted: ev.aborted } : {}), ...(ev.textMs !== undefined ? { textMs: ev.textMs } : {}), ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };
    case 'tool-call':
      return { type: 'step/tool-call', run: ev.run, step: ev.step, ...(ev.stepId !== undefined ? { stepId: ev.stepId } : {}), toolCallId: ev.toolCallId, name: ev.name, arguments: ev.arguments, ts: ev.ts ?? 0, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };
    case 'tool-call-result':
      return { type: 'step/tool-call-result', run: ev.run, toolCallId: ev.toolCallId, result: ev.result, ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}), ...(ev.subcall === true ? { subcall: true, ...(ev.name !== undefined ? { name: ev.name } : {}), ...(ev.arguments !== undefined ? { arguments: ev.arguments } : {}) } : {}), ts: ev.ts ?? 0, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };
    case 'inject':
      // injectionId 回填（M-A 批面）：cr-707 前的 journal-inject 行无该键——
      // 序列化时按 fold.ts 事件注入卡的同款合成词形回填（jinj-<run>-<seq>），
      // 迁移产物 v2 行恒有注入锚（前端注入卡挂靠不退化）。
      return { type: 'inject', run: ev.run, content: ev.content, ...(ev.requestId !== undefined ? { requestId: ev.requestId } : {}), injectionId: ev.injectionId ?? 'jinj-' + ev.run + '-' + (ev.seq ?? 0), ...(ev.injectSource !== undefined ? { injectSource: ev.injectSource } : {}), ...(ev.label !== undefined ? { label: ev.label } : {}), ...(ev.payload !== undefined ? { payload: ev.payload } : {}), ts: ev.ts ?? 0, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };
    case 'run-end':
      return { type: 'run-end', run: ev.run, finish: ev.finish, ...(ev.usage !== undefined ? { usage: ev.usage } : {}), ...(ev.model !== undefined ? { model: ev.model } : {}), ...(ev.errorMessage !== undefined ? { errorMessage: ev.errorMessage } : {}), ...(ev.runMs !== undefined ? { runMs: ev.runMs } : {}), ts: ev.ts, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) };
    default:
      return null;
  }
}

/** 事件 → v2 行（speech/context 分流 + 相位族；压缩族由调用方独立重放） */
export function eventToV2Row(ev: SessionEvent): Record<string, unknown> | null {
  if (ev.kind === 'speech') return speechRow(ev);
  if (ev.kind === 'context') return contextRow(ev);
  if (ev.kind === 'compaction' || ev.kind === 'compaction-start' || ev.kind === 'compaction-summary' || ev.kind === 'compaction-end') return null;
  return phaseRow(ev);
}

/** 边 1→2：v1 归一化事实 → v2 行序列（facts 往返恒等判据的产物面）。 */
function migrateSessionV1ToV2(form: SessionForm): SessionForm {
  const f = form.facts;
  const rows: Array<Record<string, unknown>> = [];
  // —— 事件时间线（speech ∪ contexts ∪ run 事实按全序重放）——
  // 稳定全序：ts 主序 + 收集序 tiebreak（同刻保归一化层读入序——
  // speech/contexts 按 domainFactsOf 扫描序，run 事实按 run 登记 + 事件序）。
  type Slot = { ts: number; sub: number; ev: SessionEvent } | { ts: number; sub: number; phaseRows: Array<Record<string, unknown>> };
  const slots: Slot[] = [];
  let sub = 0;
  for (const s of f.speech) slots.push({ ts: Date.parse(s.timestamp) || 0, sub: sub++, ev: s });
  for (const c of f.contexts) slots.push({ ts: Date.parse(c.timestamp) || 0, sub: sub++, ev: c });
  for (const [run, rf] of f.runs) {
    // 步面互斥（cr-1307）：aggregated 在场（v1 段行物化）时步轨迹由段行
    // 相位块承载，journal 的 reasoning/content/tool-call 事件不重放（双放
    // 会在读回后 steps 双投——旧读面靠 foldStepsOf aggregated 优先跳过，
    // 新产物行面无此互斥信号）。inject/收束/结果补行不受影响。
    const hasAgg = rf.aggregated !== undefined;
    // 步末计量随步内末相位行携带（v2 写面对齐 service.journalStep 的
    // Object.assign(last, meter)——placeEvent 按行读回 meters；v1
    // journal-step 的 meter 与相位行分离，序列化时合回末相位行）。
    const meterOf = new Map<number, Array<{ usage?: unknown; elapsedMs?: number; aborted?: boolean; textMs?: number }>>();
    for (const ev of rf.events) {
      if (ev.kind !== 'reasoning' && ev.kind !== 'content') continue;
      const m = ev as typeof ev & { usage?: unknown; elapsedMs?: number; aborted?: boolean; textMs?: number };
      if (m.usage !== undefined || m.elapsedMs !== undefined || m.aborted !== undefined || m.textMs !== undefined) {
        const bucket = meterOf.get(ev.step) ?? [];
        bucket.push({ ...(m.usage !== undefined ? { usage: m.usage } : {}), ...(m.elapsedMs !== undefined ? { elapsedMs: m.elapsedMs } : {}), ...(m.aborted !== undefined ? { aborted: m.aborted } : {}), ...(m.textMs !== undefined ? { textMs: m.textMs } : {}) });
        meterOf.set(ev.step, bucket);
      }
    }
    // 末相位行 = 该步最后一个 reasoning/content/tool-call 行（tool-call-result
    // 不算——v2 词汇它独立于步号）。meter 逐键合并进该行的序列化产物。
    const lastOfStep = new Map<number, PhaseEvent>();
    for (const ev of rf.events) {
      if (ev.kind === 'reasoning' || ev.kind === 'content' || ev.kind === 'tool-call') lastOfStep.set(ev.step, ev);
    }
    const meterApplied = new Set<PhaseEvent>();
    for (const ev of rf.events) {
      if (hasAgg && (ev.kind === 'reasoning' || ev.kind === 'content' || ev.kind === 'tool-call')) continue;
      let out = ev;
      if ((ev.kind === 'reasoning' || ev.kind === 'content' || ev.kind === 'tool-call')
        && lastOfStep.get(ev.step) === ev && !meterApplied.has(ev)) {
        const buckets = meterOf.get(ev.step);
        if (buckets !== undefined && buckets.length > 0) {
          out = buckets.reduce((acc, m) => ({ ...acc, ...m }) as typeof ev, ev);
          meterApplied.add(out);
        }
      }
      slots.push({ ts: ev.ts ?? 0, sub: sub++, ev: out });
    }
    if (rf.end !== undefined) slots.push({ ts: rf.end.ts, sub: sub++, ev: rf.end });
    // v1 聚合轨迹：subcall 档案内联后直产相位行（cr-1307）。slot 粒度 = 步
    // （ts = 步 ts——注入行按 ts 与步块正确交错，还原 v1 段行间的插位语义；
    // 步 ts 缺席 0 守首）。
    if (rf.aggregated !== undefined) {
      const steps: ProjectedStep[] = rf.aggregated.map((s) => ({ ...s, ...(s.toolCalls !== undefined ? { toolCalls: s.toolCalls.map((tc) => ({ ...tc })) } : {}) }));
      injectSubcallCards(steps, form.subcallArchive as JournalToolResult[]);
      steps.forEach((s, i) => {
        const single = segmentRowToPhaseRows({ role: 'agent', source: 'segment', run, content: '', message_id: '', timestamp: '', agent_id: f.domain, steps: [s] } as never, i).rows;
        if (single.length === 0) return;
        slots.push({ ts: (single[0] as { ts?: number }).ts ?? 0, sub: sub++, phaseRows: single });
      });
    }
  }
  slots.sort((a, b) => (a.ts - b.ts) || (a.sub - b.sub));
  for (const slot of slots) {
    if ('phaseRows' in slot) { rows.push(...slot.phaseRows); continue; }
    const row = eventToV2Row(slot.ev);
    if (row !== null) rows.push(row);
  }
  // —— 压缩代（compaction 单事件重放——fold 三态语义键）——
  for (const gen of f.compactions) {
    rows.push({
      type: 'compaction', run: gen.run,
      ...(gen.boundarySeq > 0 ? { boundarySeq: gen.boundarySeq } : {}),
      ...(gen.stats !== undefined ? { stats: gen.stats } : {}),
      ...(gen.model !== undefined ? { model: gen.model } : {}),
      ...(gen.summary !== '' ? { summary: gen.summary } : {}),
      ts: gen.endTs,
    });
    // 代末 run-end（机制 run 收束——writer.compaction 双行同构）：
    // journal-settled 真实收束在场（带 seq/usage/model）则原样复用——
    // 无条件合成会覆盖丢 seq（writer~writer 现场：settled seq 4816 被裸行顶掉）。
    const je = f.runs.get(gen.run)?.end;
    const endRow = je !== undefined ? eventToV2Row(je) : null;
    rows.push(endRow ?? { type: 'run-end', run: gen.run, finish: 'completed', ts: gen.endTs });
  }
  // seq 统一重排（cr-1307）：迁移产物行序 = ts 全序（重放序），恒等携带的
  // 旧 seq 与新行序矛盾；按产物文件序重分配（v2 写面规范——行恒带 seq，
  // foldStepsOf 相位序推导依赖 ev.seq）。与 cr-1306 工具同款策略。
  const v2Rows = rows.map((r, i) => ({ ...r, seq: i + 1 }));
  return { ...form, v2Rows };
}

/** 边 0→1：无 version 头（最早 writer 形态）→ v1 头行标注。行面零变化
 *  （v0 与 v1 同为行级判别词汇；头行 version 缺席读侧回落 1——
  * readDomainFacts `header?.version ?? 1`），本边只升头行标注。 */
function migrateSessionV0ToV1(form: SessionForm): SessionForm {
  void form;
  return form;
}

/** 会话文件链（v0 无标注 → v1 三文件 → v2 单文件事件日志——注册即四断言） */
export const SESSION_CHAIN: MigrationEdge<SessionForm>[] = [
  { from: 0, to: 1, migrate: migrateSessionV0ToV1 },
  { from: 1, to: 2, migrate: migrateSessionV1ToV2 },
];
assertChainIntegrity('session-format', SESSION_CHAIN);

/** 链驱动（M-B 工具入口——v1 形态值 → v2 行序列 + 头行） */
export function migrateSessionForm(stored: VersionedValue<SessionForm>): { rows: Array<Record<string, unknown>>; header: Record<string, unknown> } {
  const { value } = runChain(SESSION_CHAIN, stored);
  return { rows: value.v2Rows, header: v2Header(value.header) };
}

// —— facts 语义相等判据（M-B cr-1271 对账单源）——
// 迁移边 facts 往返判据从 M-A 测试提升为库面（migrate-sessions-v2 工具
// 对账 + 测试共用；fold 是 facts 的确定函数——facts 相等 ⇔ fold 四投影
// 恒等）。injectionId 回填感知：v1 无锚侧按边同款词形补合成锚再比对。

/** canonical 序列化（键序无关 + seq 豁免 + 空数组键归一——cr-1307 产物
 *  行序重排后旧 seq 必然漂移：seq 是文件序身份锚非语义内容；空数组键只
 *  出现在聚合直通/事件重建单侧（键面差无语义）。对象键排序后序列化。） */
function canonOf(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonOf).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v as Record<string, unknown>).sort()
      .filter((k) => k !== 'seq')
      .filter((k) => !Array.isArray((v as Record<string, unknown>)[k]) || ((v as Record<string, unknown>)[k] as unknown[]).length > 0)
      .map((k) => JSON.stringify(k) + ':' + canonOf((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** 注入事件比对前处理：无 injectionId 的 v1 侧按边同款词形补锚 */
function canonInjectStrip(run: string, v: unknown): string {
  if (typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'inject' && (v as { injectionId?: string }).injectionId === undefined) {
    const { seq } = v as { seq?: number };
    return canonOf(normBare({ ...v, injectionId: 'jinj-' + run + '-' + (seq ?? 0) }));
  }
  return canonOf(normBare(v));
}

/** cr-978 裸行归一化：缺键（undefined）与 v2 序列化兜底在比对面等价——
 *  字符串面（messageId/timestamp/agentId/content）兜底 ''；数字面 ts 兜底 0
 *  （cr-697 前 journal 行无盖戳 → 边 ts ?? 0 → 读回 Number(?? 0)＝0；
 *  早期子 Agent 裸行 / 群转发 run-settled 行缺 message_id/timestamp 同理。
 *  迁移后这些行落兜底键——读侧既有容错（idKeyOf/可选链）等价消费）。 */
function normBare(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) {
      if (k === 'messageId' || k === 'timestamp' || k === 'agentId' || k === 'content') { out[k] = ''; continue; }
      if (k === 'ts') { out[k] = 0; continue; }
    }
    out[k] = o[k];
  }
  return out;
}

/**
 * 已收束 run 的无结果调用 synth 归一（对拍对齐 fold-core 事件路径语义）：
 * 聚合直通面原样保留 result:null，事件重建面按 foldStepsOf 既有规则合成
 * （finish 正常 → {ok:true}；finish 异常 → aborted ? TOOL_NOT_STARTED :
 * TOOL_OUTCOME_UNKNOWN；未收束 run → 保持 null）。差异方向 = 向 v2 收敛。
 */
export function synthNullResults(steps: ProjectedStep[], rf: { end?: { finish?: string } }): ProjectedStep[] {
  const finish = rf.end?.finish;
  return steps.map((s) => {
    if (s.toolCalls === undefined) return s;
    const stepAborted = s.aborted === true;
    return {
      ...s,
      toolCalls: s.toolCalls.map((tc) => {
        if (tc.result !== null) return tc;
        const synth = finish !== undefined
          ? (finish !== 'completed'
            ? (stepAborted ? { ok: false, error: 'TOOL_NOT_STARTED' } : { ok: false, error: 'TOOL_OUTCOME_UNKNOWN' })
            : { ok: true })
          : null;
        return { ...tc, result: synth };
      }),
    };
  });
}

/**
 * 两侧 facts 语义相等（diff 首处差异描述——工具报告面）。比对口径：
 *  · seq 全面豁免（cr-1307：产物行序按 ts 全序重排 + 统一重分配——
 *    旧 seq 是文件序身份锚非语义内容，恒等携带改判产物重排后必然漂移）；
 *  · speech/contexts 按 messageId 对齐逐条 canon（domain 置空——归属域不是往返面）；
 *  · runs 逐 run events/end canon 比对（inject 锚回填感知）；aggregated
 *    面（cr-1307）= foldStepsOf 投影恒等——v1 侧聚合直通（档案内联 +
 *    synth 归一）vs v2 侧事件重建，canonStep 归一（seq 豁免/空数组归一）；
 *  · meters 非空逐键相等（v1 空 meter 恒占键 vs v2 只记有字段的行）；
 *  · compactions canon（appendGeneration 两侧均重编代序）。
 */
export function sessionFactsEqual(a: DomainFacts, b: DomainFacts): { ok: boolean; diff?: string } {
  const fail = (diff: string): { ok: false; diff: string } => ({ ok: false, diff });
  if (b.version !== 2) return fail('目标侧 version=' + b.version);
  if (a.domain !== b.domain) return fail('domain ' + a.domain + ' != ' + b.domain);
  // speech/contexts：canon 多重集比对（同 canon = 全字段含 id 相同；群转发
  // run-settled 裸行多条空 messageId——按 id 对齐会互撞，多重集天然覆盖）
  for (const [name, listA, listB] of [
    ['speech', a.speech, b.speech],
    ['contexts', a.contexts, b.contexts],
  ] as const) {
    const bagA = listA.map((e) => canonOf(normBare({ ...e, domain: '' }))).sort();
    const bagB = listB.map((e) => canonOf(normBare({ ...e, domain: '' }))).sort();
    if (bagA.join('\n') !== bagB.join('\n')) {
      const first = bagA.find((s) => !bagB.includes(s)) ?? bagB.find((s) => !bagA.includes(s)) ?? '';
      return fail(name + ' 多重集不等（' + bagA.length + ' vs ' + bagB.length + '）：首差 ' + first.slice(0, 160));
    }
  }
  const runsA = [...a.runs.keys()].sort();
  const runsB = [...b.runs.keys()].sort();
  if (JSON.stringify(runsA) !== JSON.stringify(runsB)) return fail('runs 键集不等（' + runsA.length + ' vs ' + runsB.length + '）');
  for (const run of runsA) {
    const fa = a.runs.get(run)!;
    const fb = b.runs.get(run)!;
    // events：canon 多重集比对——v2 输出行序按 ts 全序重放，journal 落盘
    // 延迟的 inject（ts 早于步块、文件序在末）迁移后插位前移（ts 纠偏），
    // 逐位比对恒红；语义内容（多重集）恒等才是判据面。步面互斥（cr-1307）：
    // aggregated 在场侧剔除步相位事件（读面 foldStepsOf aggregated 优先跳过
    // 同语义——journal 步块已被段行物化取代，不构成往返面）。
    const phaseOf = (v: unknown): boolean => {
      const k = (v as { kind?: string }).kind;
      return k === 'reasoning' || k === 'content' || k === 'tool-call';
    };
    const strip = (v: unknown) => canonInjectStrip(run, v);
    const evA = (fa.aggregated !== undefined ? fa.events.filter((ev) => !phaseOf(ev)) : fa.events).map(strip).sort();
    const evB = (fb.aggregated !== undefined ? fb.events.filter((ev) => !phaseOf(ev)) : fb.events).map(strip).sort();
    if (evA.join('\n') !== evB.join('\n')) {
      const first = evA.find((s) => !evB.includes(s)) ?? evB.find((s) => !evA.includes(s)) ?? '';
      return fail('run ' + run + ' events 多重集不等（' + fa.events.length + ' vs ' + fb.events.length + '）：首差 ' + first.slice(0, 160));
    }
    if (strip(fb.end) !== strip(fa.end)) return fail('run ' + run + ' end 不等');
    if (fa.aggregated !== undefined || fb.aggregated !== undefined) {
      if (fa.aggregated === undefined || fb.aggregated === undefined) return fail('run ' + run + ' aggregated 单侧缺席');
      // cr-1307：aggregated 对拍面 = foldStepsOf 投影恒等（语义收敛面）——
      // v1 侧聚合直通（subcall 卡按档案内联后 null→synth 归一），v2 侧
      // 事件重建投影，两侧 steps canon 比对。豁免与归一自 cr-1306 工具
      // 提升为库面：seq（边按 ts 全序重排放弃段行 seq）；空数组键归一
      // （展开行 vs 聚合步的键面差）；无结果调用 synth 归一（v1 侧 null
      // 直通 vs v2 侧 foldStepsOf 合成终态——差异方向向 v2 收敛）。
      const v1Steps = fa.aggregated.map((s) => ({ ...s, ...(s.toolCalls !== undefined ? { toolCalls: s.toolCalls.map((tc) => ({ ...tc })) } : {}) }));
      injectSubcallCards(v1Steps, a.subcallArchive);
      const v1Proj = canonOf(synthNullResults(v1Steps, fa));
      const v2Steps = foldStepsOf(fb, [])?.steps ?? [];
      if (v1Proj !== canonOf(v2Steps)) return fail('run ' + run + ' aggregated 投影不等');
    }
    const nonEmpty = (m: Map<number, unknown>) => [...m.entries()].filter(([, v]) => v !== undefined && Object.keys(v as object).length > 0);
    if (canonOf(nonEmpty(fb.meters)) !== canonOf(nonEmpty(fa.meters))) return fail('run ' + run + ' meters 不等');
  }
  if (canonOf(b.compactions) !== canonOf(a.compactions)) return fail('compactions 不等（' + a.compactions.length + ' vs ' + b.compactions.length + '）');
  return { ok: true };
}
