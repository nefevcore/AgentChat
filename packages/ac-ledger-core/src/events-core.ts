// ============================================================
// events-core.ts —— 事件词汇 v2 + 跨版本归一化·纯核（cr-974 / cr-972；cr-1245 B1 自 ac-ledger events-v2 拆入——零 fs，fs 壳 readDomainFacts/readConversationFacts 留 ac-ledger）
//
// 单文件事件日志（messages.jsonl 头行 version:2）的一等事件词汇
//（D-2：标记行 run-end + step/* 细粒度相位族；行序即步内序——cr-946
// textBeforeTools 退役）。归一化层 readSessionFacts 把 v1 三文件形态
//（messages 行 + journal 双判别行 + subcalls 档案）映射进同一词汇——
// fold 单源只认本文件词汇（fold.ts）。
//
// v1 映射要点：journal-step 按相位拆行（textBeforeTools 存量保留）；
// journal-settled → run-end（ok→completed）；段行（source='segment'）是
// journal 的物化产物——归一化不展开进事件流，作为该 run 的**聚合轨迹**
// 直入（与 journal 相位事件互斥优先，沿用 stepsOfLedger ?? stepsOfRun
// 回落语义）；subcalls.jsonl 档案行 → subcall 结果事件（D-1 内联的 v1 形）。
// cr-1307：aggOrder 顺序簿退役（段行/注入行的插位还原账）——cr-1306
// 存量归一后盘上段行/注入行归零、迁移边直产 v2 相位行，记账分支删除。
// ============================================================
import { normalizeAttachments, type JournalLine, type JournalStep, type JournalToolResult, type LedgerAttachment, type LedgerRow, type ProjectedStep, type RunUsage } from './records.ts';

/** 附件旁挂（cr-1278）：行体 → 事件的可选键片段（非法/空 = 零键） */
function attachOf(v: unknown): { attachments?: LedgerAttachment[] } {
  const a = normalizeAttachments(v);
  return a !== undefined ? { attachments: a } : {};
}

/** run 终态（run-end.finish；v1 settled.finish ok → completed） */
export type RunFinish = 'completed' | 'interrupted' | 'error';

/** 发言行（终稿 / 入站 / 通知——v2 type='message'；v1 role 判别行同构） */
export interface SpeechEvent {
  kind: 'speech';
  role: 'agent';
  agentId: string;
  /** 归属域（事件行投影的 agent_id 取源——cr-946 存量 restarted 行） */
  domain: string;
  content: string;
  /** 多模态附件引用（cr-1278：入站发言行旁挂——回放还原为 LlmMessage.attachments） */
  attachments?: LedgerAttachment[];
  messageId: string;
  requestId?: string;
  run?: string;
  runMs?: number;
  timestamp: string;
  seq?: number;
  /** v1 viewer 存量行的 run 键落形（source=run:<id>） */
  sourceRun?: string;
}

/** 上下文行（v2 type='context'；v1 role='context' 行——source 词表沿用） */
export interface ContextEvent {
  kind: 'context';
  agentId: string;
  /** 归属域（cr-1132：viewer 域恒值归属归一判据——落账域目录，读侧单源） */
  domain?: string;
  source: string;
  content: string;
  label?: string;
  payload?: unknown;
  run?: string;
  requestId?: string;
  injectSource?: string;
  messageId: string;
  timestamp: string;
  seq?: number;
}

/** 步内相位事件族（v2 step/*；ts = epoch ms；步末计量随步内末相位行
 *  携带——usage/elapsedMs/aborted/textMs 为 wire 可选字段） */
export type PhaseEvent =
  | { kind: 'reasoning'; run: string; step: number; stepId?: string; text: string; reasoningMs?: number; ts?: number; seq?: number; usage?: StepMeter['usage']; elapsedMs?: number; aborted?: boolean; textMs?: number }
  | { kind: 'content'; run: string; step: number; stepId?: string; text: string; ts?: number; seq?: number; usage?: StepMeter['usage']; elapsedMs?: number; aborted?: boolean; textMs?: number }
  | { kind: 'tool-call'; run: string; step: number; stepId?: string; toolCallId: string; name: string; arguments: string; ts?: number; seq?: number }
  | { kind: 'tool-call-result'; run: string; toolCallId: string; result: { ok: boolean; output?: unknown; error?: string }; durationMs?: number; subcall?: boolean; name?: string; arguments?: string; ts?: number; seq?: number };

/** 步末计量（usage/elapsed/aborted——随步内末相位事件携带） */
export interface StepMeter {
  usage?: { prompt: number; completion: number; total?: number };
  elapsedMs?: number;
  aborted?: boolean;
  textMs?: number;
}

/** 注入事件（v2 type='inject'；cr-707 全字段快照） */
export interface InjectEvent {
  kind: 'inject';
  run: string;
  content: string;
  requestId?: string;
  injectionId?: string;
  injectSource?: string;
  label?: string;
  payload?: unknown;
  /** 多模态附件引用（cr-1278：busy-steer 插话携带的图——消费点落账、回放还原） */
  attachments?: LedgerAttachment[];
  ts?: number;
  seq?: number;
}

/** run 收束标记行（v2 type='run-end'——落账即 durable，回放闸门锚） */
export interface RunEndEvent {
  kind: 'run-end';
  run: string;
  finish: RunFinish;
  usage?: RunUsage;
  model?: string;
  errorMessage?: string;
  runMs?: number;
  ts: number;
  seq?: number;
}

/** 压缩事件族（v2 compaction/*——§2.3；fold 三态的语义边界）
 *  cr-1160 P1：新增单事件形态 compaction（三连的收编——一行携带全部
 *  压缩语义；append+fsync 行级原子，无需两阶段）。旧三连读侧归并。 */
export type CompactionEvent =
  | { kind: 'compaction'; run: string; boundarySeq?: number; endTs: number; summary?: string; stats?: { shadowedRows?: number; estimatedTokens?: number }; model?: string; generation?: number; ts: number; seq?: number }
  | { kind: 'compaction-start'; run: string; ts: number; seq?: number }
  | { kind: 'compaction-summary'; run: string; summary: string; ts: number; seq?: number }
  | { kind: 'compaction-end'; run: string; boundarySeq?: number; ts: number; seq?: number };

/** v2 事件全集 */
export type SessionEvent = SpeechEvent | ContextEvent | PhaseEvent | InjectEvent | RunEndEvent | CompactionEvent;

/** 单 run 事实（fold 输入单位）：相位/注入/收束事件 + v1 聚合轨迹 */
export interface RunFactsV2 {
  events: Array<PhaseEvent | InjectEvent>;
  /** 步末计量（v1 journal-step / v2 末相位行——键 = step 序号） */
  meters: Map<number, StepMeter>;
  end?: RunEndEvent;
  /** v1 物化段行的聚合 steps（在场则优先于相位重建——读兼容） */
  aggregated?: ProjectedStep[];
}

/** 压缩事实（§2.3 fold 三态语义边界——最新一次压缩）
 *
 * cr-1160 P2：边界升级为多轮叠加——DomainFacts.compactions 按文件序记
 * 全部压缩代（compaction 单事件 + 旧三连归并；facts.compaction 保留最新
 * 一代兼容既有消费面）。行 shadow 判定 = 被任一代命中（fold 层
 * rowShadowedBy 谓词——位置/时刻/文件位置三级裁决）。 */
export interface CompactionFacts {
  /** 压缩 run */
  run: string;
  /** 摘要全文（compaction/summary 事件携带——回放注入 system 头取源；
   *  cr-1160 P3 起形态校验不合格的代落空串——回放头回落上一代概要） */
  summary: string;
  /** 覆盖边界（shadowed 前缀的最大 seq——exclusive；compaction/end 行
   *  携带，缺席回落该 run 三事件最大 seq） */
  boundarySeq: number;
  /** 压缩收束时刻（compaction/end 的 ts——cr-1156 时刻维兜底：物理重写
   *  后 writer 重启小 seq 空间，事件后落账行 seq 可能 ≤ boundarySeq——seq
   *  比较只对事件前 shadowed 前缀负责。缺省 0 = 时刻维不生效（纯 seq）。 */
  endTs: number;
  /** 压缩代序（1 起，cr-1160 P4：行 generation 坐标，域内单调） */
  generation?: number;
  /** 本代概要缺席标记（cr-1160 P3：形态不合格 → 概要未更新——回放头
   *  取上一代概要；stats/model 仍记） */
  summaryOmitted?: boolean;
  /** 审计面（cr-1160 P1：单事件携带；旧三连无） */
  stats?: { shadowedRows?: number; estimatedTokens?: number };
  /** 摘要生成模型（审计面） */
  model?: string;
}

/**
 * 一个域（agent 目录）的归一化事实
 */
export interface DomainFacts {
  domain: string;
  speech: SpeechEvent[];
  contexts: ContextEvent[];
  runs: Map<string, RunFactsV2>;
  /** v1 subcalls 档案（subcall 结果事件——联查注入聚合轨迹） */
  subcallArchive: JournalToolResult[];
  /** 日志版本（头行） */
  version: number;
  /** 最新压缩事实（compaction/* 事件——§2.3；缺席 = 无压缩；兼容面——
   *  最新代恒等于 compactions 末位） */
  compaction?: CompactionFacts;
  /** 全部压缩代（cr-1160 P2：按文件序——单事件 + 旧三连归并；多轮边界
   *  叠加判定的事实源） */
  compactions: CompactionFacts[];
}

const V2_TYPES = new Set(['message', 'context', 'step/reasoning', 'step/content', 'step/tool-call', 'step/tool-call-result', 'inject', 'run-end', 'compaction', 'compaction/start', 'compaction/summary', 'compaction/end']);

function runOf(facts: Map<string, RunFactsV2>, run: string): RunFactsV2 {
  let f = facts.get(run);
  if (f === undefined) { f = { events: [], meters: new Map() }; facts.set(run, f); }
  return f;
}

/** v2 单文件行 → 事件（未知 type 安全忽略） */
function v2RowToEvent(row: Record<string, unknown>): SessionEvent | 'segment' | null {
  switch (row.type) {
    case 'message':
      return { kind: 'speech', role: 'agent', agentId: String(row.agent_id ?? ''), domain: '', content: String(row.content ?? ''), messageId: String(row.message_id ?? ''), ...(row.requestId !== undefined ? { requestId: String(row.requestId) } : {}), ...(row.run !== undefined && row.run !== '' ? { run: String(row.run) } : {}), ...(row.runMs !== undefined ? { runMs: Number(row.runMs) } : {}), ...attachOf(row.attachments), timestamp: String(row.timestamp ?? ''), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}), ...(typeof row.source === 'string' && row.source.startsWith('run:') ? { sourceRun: row.source.slice(4) } : {}) };
    case 'context':
      return { kind: 'context', agentId: String(row.agent_id ?? ''), source: String(row.source ?? ''), content: String(row.content ?? ''), ...(row.label !== undefined ? { label: String(row.label) } : {}), ...(row.payload !== undefined ? { payload: row.payload } : {}), ...(row.run !== undefined && row.run !== '' ? { run: String(row.run) } : {}), ...(row.requestId !== undefined ? { requestId: String(row.requestId) } : {}), ...(row.injectSource !== undefined ? { injectSource: String(row.injectSource) } : {}), messageId: String(row.message_id ?? ''), timestamp: String(row.timestamp ?? ''), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'step/reasoning':
    case 'step/content':
      return { kind: row.type === 'step/reasoning' ? 'reasoning' : 'content', run: String(row.run ?? ''), step: Number(row.step ?? 0), ...(row.stepId !== undefined ? { stepId: String(row.stepId) } : {}), text: String(row.text ?? ''), ...(row.reasoningMs !== undefined ? { reasoningMs: Number(row.reasoningMs) } : {}), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}), ...(row.usage !== undefined ? { usage: row.usage as StepMeter['usage'] } : {}), ...(row.elapsedMs !== undefined ? { elapsedMs: Number(row.elapsedMs) } : {}), ...(row.aborted === true ? { aborted: true } : {}), ...(row.textMs !== undefined ? { textMs: Number(row.textMs) } : {}) };
    case 'step/tool-call':
      return { kind: 'tool-call', run: String(row.run ?? ''), step: Number(row.step ?? 0), ...(row.stepId !== undefined ? { stepId: String(row.stepId) } : {}), toolCallId: String(row.toolCallId ?? ''), name: String(row.name ?? ''), arguments: String(row.arguments ?? '{}'), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'step/tool-call-result':
      return { kind: 'tool-call-result', run: String(row.run ?? ''), toolCallId: String(row.toolCallId ?? ''), result: (row.result ?? { ok: false }) as { ok: boolean; output?: unknown; error?: string }, ...(row.durationMs !== undefined ? { durationMs: Number(row.durationMs) } : {}), ...(row.subcall === true ? { subcall: true, ...(row.name !== undefined ? { name: String(row.name) } : {}), ...(row.arguments !== undefined ? { arguments: String(row.arguments) } : {}) } : {}), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'inject':
      return { kind: 'inject', run: String(row.run ?? ''), content: String(row.content ?? ''), ...(row.requestId !== undefined ? { requestId: String(row.requestId) } : {}), ...(row.injectionId !== undefined ? { injectionId: String(row.injectionId) } : {}), ...(row.injectSource !== undefined ? { injectSource: String(row.injectSource) } : {}), ...(row.label !== undefined ? { label: String(row.label) } : {}), ...(row.payload !== undefined ? { payload: row.payload } : {}), ...attachOf(row.attachments), ts: Number(row.ts ?? Date.now()), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'compaction':
      return { kind: 'compaction', run: String(row.run ?? ''), ...(row.boundarySeq !== undefined ? { boundarySeq: Number(row.boundarySeq) } : {}), endTs: Number(row.ts ?? 0), ...(row.summary !== undefined ? { summary: String(row.summary ?? '') } : {}), ...(row.stats !== undefined ? { stats: row.stats as { shadowedRows?: number; estimatedTokens?: number } } : {}), ...(row.model !== undefined ? { model: String(row.model) } : {}), ...(row.generation !== undefined ? { generation: Number(row.generation) } : {}), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'compaction/start':
      return { kind: 'compaction-start', run: String(row.run ?? ''), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'compaction/summary':
      return { kind: 'compaction-summary', run: String(row.run ?? ''), summary: String(row.summary ?? ''), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'compaction/end':
      return { kind: 'compaction-end', run: String(row.run ?? ''), ...(row.boundarySeq !== undefined ? { boundarySeq: Number(row.boundarySeq) } : {}), ts: Number(row.ts ?? 0), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    case 'run-end':
      return { kind: 'run-end', run: String(row.run ?? ''), finish: row.finish === 'interrupted' || row.finish === 'error' ? row.finish : 'completed', ...(row.usage !== undefined ? { usage: row.usage as RunUsage } : {}), ...(row.model !== undefined ? { model: String(row.model) } : {}), ...(row.errorMessage !== undefined ? { errorMessage: String(row.errorMessage) } : {}), ...(row.runMs !== undefined ? { runMs: Number(row.runMs) } : {}), ts: Number(row.ts ?? Date.now()), ...(row.seq !== undefined ? { seq: Number(row.seq) } : {}) };
    default:
      return null; // 未知 type 安全忽略（compaction/* 由 fold 单独消费；段行另路）
  }
}

/** v1 journal-step → 相位事件序列（含步末计量挂末行；行序即步内序——
 *  textBeforeTools 存量行按其标注还原相位序，v2 起该字段退役） */
function expandJournalStep(line: JournalStep): { phases: Array<PhaseEvent | InjectEvent>; meter: StepMeter } {
  const phases: Array<PhaseEvent | InjectEvent> = [];
  const base = { run: line.run, step: line.step, ...(line.stepId !== undefined ? { stepId: line.stepId } : {}) };
  const contentEv = line.content !== '' ? { kind: 'content' as const, ...base, text: line.content, ts: line.ts, ...(line.seq !== undefined ? { seq: line.seq } : {}) } : undefined;
  if (line.reasoning !== undefined && line.reasoning !== '') {
    phases.push({ kind: 'reasoning', ...base, text: line.reasoning, ...(line.reasoningMs !== undefined ? { reasoningMs: line.reasoningMs } : {}), ts: line.ts, ...(line.seq !== undefined ? { seq: line.seq } : {}) });
  }
  // cr-946 相位序：textBeforeTools = 正文先于工具调用；缺省工具先行
  if (line.textBeforeTools === true && contentEv !== undefined) phases.push(contentEv);
  for (const tc of line.toolCalls ?? []) {
    phases.push({ kind: 'tool-call', ...base, toolCallId: tc.id, name: tc.name, arguments: tc.arguments, ts: line.ts, ...(line.seq !== undefined ? { seq: line.seq } : {}) });
  }
  if (line.textBeforeTools !== true && contentEv !== undefined) phases.push(contentEv);
  // 早期形态（cr-596 前）：步行自带 toolResults 按位对应 → 结果补行事件
  for (let i = 0; i < (line.toolResults?.length ?? 0); i++) {
    const tr = line.toolResults![i]!;
    const tc = (line.toolCalls ?? []).at(i);
    if (tc === undefined) break;
    phases.push({ kind: 'tool-call-result', run: line.run, toolCallId: tc.id, result: { ok: tr.ok, ...(tr.output !== undefined ? { output: tr.output } : {}), ...(tr.error !== undefined ? { error: tr.error } : {}) }, ts: line.ts, ...(line.seq !== undefined ? { seq: line.seq } : {}) });
  }
  const meter: StepMeter = {
    ...(line.usage !== undefined ? { usage: line.usage } : {}),
    ...(line.elapsedMs !== undefined ? { elapsedMs: line.elapsedMs } : {}),
    ...(line.aborted === true ? { aborted: true } : {}),
    ...(line.textMs !== undefined ? { textMs: line.textMs } : {}),
  };
  return { phases, meter };
}

/**
 * 单域归一化纯核（messages rows + journal 行 + subcalls 档案三源 →
 * DomainFacts；fs 读入由 ac-ledger readDomainFacts 壳完成）。
 * v2 单文件：journal/subcalls 缺席为常态；v1 会话三源并存（段行聚合
 * 优先、journal 兜底的互斥语义在 fold 的 steps 重建处收口）。
 */
export function domainFactsOf(
  domain: string,
  version: number,
  rows: LedgerRow[],
  journal: JournalLine[],
  subcallArchive: JournalToolResult[],
): DomainFacts {
  const out: DomainFacts = { domain, speech: [], contexts: [], runs: new Map(), subcallArchive, version, compactions: [] };
  // 旧三连归并暂存（run → 半成品代；end 到达成代）
  const pendingCompactions = new Map<string, CompactionFacts>();
  for (const r of rows as Array<LedgerRow & Record<string, unknown>>) {
    if (V2_TYPES.has(String(r.type ?? ''))) {
      const ev = v2RowToEvent(r as Record<string, unknown>);
      if (ev === null) continue;
      if (ev === 'segment') continue;
      placeEvent(out, ev, pendingCompactions);
      continue;
    }
    // v1 role 判别行
    if (r.role === 'context') {
      out.contexts.push({ kind: 'context', agentId: r.agent_id, domain, source: r.source ?? '', content: r.content, ...(r.label !== undefined ? { label: r.label } : {}), ...(r.payload !== undefined ? { payload: r.payload } : {}), ...(r.run !== undefined ? { run: r.run } : {}), ...(r.requestId !== undefined ? { requestId: r.requestId } : {}), ...(r.injectSource !== undefined ? { injectSource: r.injectSource } : {}), messageId: r.message_id, timestamp: r.timestamp, ...(r.seq !== undefined ? { seq: r.seq } : {}) });
      continue;
    }
    // v1 发言行（role 判别仅 agent/context 两值——context 已分流）
    if (r.source === 'segment') {
      // v1 物化段行：聚合轨迹直入该 run（与 journal 相位事件互斥——fold 优先聚合）
      if (r.run === undefined) continue;
      const f = runOf(out.runs, r.run);
      const steps = Array.isArray(r.steps) ? r.steps as ProjectedStep[] : [];
      f.aggregated = [...(f.aggregated ?? []), ...steps];
      continue;
    }
    if (r.source === 'inject') {
      if (r.run === undefined) continue;
      const ts0 = Date.parse(r.timestamp);
      const ev: InjectEvent = { kind: 'inject', run: r.run, content: r.content, ...attachOf(r.attachments), ...(r.requestId !== undefined ? { requestId: r.requestId } : {}), injectionId: r.message_id, ...(r.injectSource !== undefined ? { injectSource: r.injectSource } : {}), ...(r.label !== undefined ? { label: r.label } : {}), ...(r.payload !== undefined ? { payload: r.payload } : {}), ts: Number.isFinite(ts0) ? ts0 : 0, ...(r.seq !== undefined ? { seq: r.seq } : {}) };
      const f = runOf(out.runs, r.run);
      f.events.push(ev);
      continue;
    }
    if (String(r.message_id).startsWith('seg-')) continue; // cr-640 存量文本段行（无 source 标记）——过滤防双计；String 容忍异常缺 id 行（手写夹具/极端存量）
    out.speech.push({ kind: 'speech', role: 'agent', agentId: r.agent_id, domain, content: r.content, ...attachOf(r.attachments), messageId: r.message_id, ...(r.requestId !== undefined ? { requestId: r.requestId } : {}), ...(r.run !== undefined && r.run !== '' ? { run: r.run } : {}), ...(r.runMs !== undefined ? { runMs: r.runMs } : {}), timestamp: r.timestamp, ...(r.seq !== undefined ? { seq: r.seq } : {}), ...(typeof r.source === 'string' && r.source.startsWith('run:') ? { sourceRun: r.source.slice(4) } : {}) });
  }
  // v1 journal 行（v2 会话恒空）
  for (const line of journal) {
    if (line.type === 'journal-step') {
      const { phases, meter } = expandJournalStep(line);
      const f = runOf(out.runs, line.run);
      f.events.push(...phases);
      f.meters.set(line.step, meter);
    } else if (line.type === 'journal-inject') {
      runOf(out.runs, line.run).events.push({ kind: 'inject', run: line.run, content: line.content, ...(line.requestId !== undefined ? { requestId: line.requestId } : {}), ...(line.injectionId !== undefined ? { injectionId: line.injectionId } : {}), ...(line.injectSource !== undefined ? { injectSource: line.injectSource } : {}), ...(line.label !== undefined ? { label: line.label } : {}), ...(line.payload !== undefined ? { payload: line.payload } : {}), ts: line.ts, ...(line.seq !== undefined ? { seq: line.seq } : {}) });
    } else if (line.type === 'journal-tool-result') {
      runOf(out.runs, line.run).events.push({ kind: 'tool-call-result', run: line.run, toolCallId: line.toolCallId, result: line.result, ...(line.durationMs !== undefined ? { durationMs: line.durationMs } : {}), ...(line.subcall === true ? { subcall: true, ...(line.name !== undefined ? { name: line.name } : {}), ...(line.arguments !== undefined ? { arguments: line.arguments } : {}) } : {}), ts: line.ts, ...(line.seq !== undefined ? { seq: line.seq } : {}) });
    } else {
      // 判别剩余 = journal-settled（收束 → run-end，ok → completed）
      runOf(out.runs, line.run).end = { kind: 'run-end', run: line.run, finish: line.finish === 'ok' ? 'completed' : line.finish, ...(line.usage !== undefined ? { usage: line.usage } : {}), ...(line.model !== undefined ? { model: line.model } : {}), ts: (line as { ts?: number }).ts ?? 0, ...(line.seq !== undefined ? { seq: line.seq } : {}) };
    }
  }
  return out;
}

/**
 * 压缩代边界判定（cr-1245 B1 单源）：declared > 0 取声明值；≤0/缺席
 * （存量老 writer 显式写 0 的现场形态）= 无有效边界 → 回落事件自身
 * seq（边界 = 事件落账位置，其后行必属新一代）。此前 ac-session-index
 * boundaryOf 与本处 placeEvent 两份实现靠注释同步——现单源于此，
 * 摄取面（session-index）与折叠面（placeEvent）一律 import 本函数。
 */
export function compactionBoundaryOf(declared: number | undefined, eventSeq: number | undefined): number {
  return (declared ?? 0) > 0 ? declared! : (eventSeq ?? 0);
}

function placeEvent(facts: DomainFacts, ev: SessionEvent, pending: Map<string, CompactionFacts>): void {
  switch (ev.kind) {
    case 'speech': facts.speech.push({ ...ev, domain: facts.domain }); return;
    case 'context': facts.contexts.push({ ...ev, domain: facts.domain }); return;
    case 'reasoning': case 'content': case 'tool-call': case 'tool-call-result': case 'inject': {
      const f = runOf(facts.runs, ev.run);
      f.events.push(ev);
      if ((ev.kind === 'reasoning' || ev.kind === 'content') && (ev.usage !== undefined || ev.elapsedMs !== undefined || ev.aborted !== undefined || ev.textMs !== undefined)) {
        const prev = f.meters.get(ev.step) ?? {};
        f.meters.set(ev.step, { ...prev, ...(ev.usage !== undefined ? { usage: ev.usage } : {}), ...(ev.elapsedMs !== undefined ? { elapsedMs: ev.elapsedMs } : {}), ...(ev.aborted !== undefined ? { aborted: ev.aborted } : {}), ...(ev.textMs !== undefined ? { textMs: ev.textMs } : {}) });
      }
      return;
    }
    case 'run-end': runOf(facts.runs, ev.run).end = ev; return;
    // 压缩代累积（cr-1160 P1/P2）：单事件直入一代；旧三连按 run 归并成
    // 一代（start 开档 → summary 填文 → end 回填边界；end 到达才入列——
    // 崩溃残留的孤 summary 不建代，回放不受未完成压缩影响）。generation
    // = 入列序 + 1；facts.compaction 恒指最新代（兼容面）。
    case 'compaction': {
      const gen: CompactionFacts = {
        run: ev.run,
        summary: ev.summary ?? '',
        boundarySeq: compactionBoundaryOf(ev.boundarySeq, ev.seq),
        endTs: ev.endTs,
        generation: ev.generation ?? facts.compactions.length + 1,
        ...(ev.summary === undefined ? { summaryOmitted: true } : {}),
        ...(ev.stats !== undefined ? { stats: ev.stats } : {}),
        ...(ev.model !== undefined ? { model: ev.model } : {}),
      };
      appendGeneration(facts, gen);
      return;
    }
    case 'compaction-summary': {
      pending.set(ev.run, { run: ev.run, summary: ev.summary, boundarySeq: 0, endTs: 0 });
      return;
    }
    case 'compaction-end': {
      const pend = pending.get(ev.run);
      if (pend === undefined) return; // 孤 end（崩溃残留）——不建代
      // 边界语义（cr-1160 重写期回归修复）：boundarySeq **≤ 0 视为无有效边界**
      // ——存量老 writer 曾显式写 boundarySeq:0（admin~admin 现场 4 代全 0），
      // 此时回落该 end 行**自身 seq**（边界 = 事件落账位置，其后行必属新一代）。
      // 曾只写 `?? 0`：缺字段路径都救不了，boundary=0 让 rowShadowedBy 恒判
      // 不 shadow（seq≥1），壳侧阈值估算把已压缩内容全当活跃 → 老会话每 run
      // 收束反复触发整理压缩（花钱且账面不降）。
      pend.boundarySeq = compactionBoundaryOf(ev.boundarySeq, ev.seq);
      pend.endTs = ev.ts; // cr-1156：收束时刻（时刻维度兜底的判据）
      appendGeneration(facts, pend);
      pending.delete(ev.run);
      return;
    }
    case 'compaction-start': return;
    default: return; // 其余未知词汇安全忽略
  }
}

/** 代入列（generation 重编为入列序 + 1——盘面乱序/跳号时归一；最新代
 *  同步 facts.compaction） */
function appendGeneration(facts: DomainFacts, gen: CompactionFacts): void {
  gen.generation = facts.compactions.length + 1;
  facts.compactions.push(gen);
  facts.compaction = gen;
}


