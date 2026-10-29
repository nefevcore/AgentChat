// ============================================================
// reader.ts —— 账本读面（宿主 webui 只读投影 / 回放；壳侧 run 前重读）
//
// viewer 投影内建于行协议：agent_id === viewer → assistant 视角，
// 否则 user/对端视角（D4.2 最大现状复用——own/peer 投影通例）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { journalLineType, type LedgerRow, type LedgerHeader, type JournalLine, type JournalStep, type JournalInject, type ProjectedStep } from './records.ts';
import type { LlmMessage } from 'ac-llm';

export interface ReadResult {
  header: LedgerHeader | null;
  rows: LedgerRow[];
}

/** 读全量账本行（messages.jsonl；目录缺席 = 空账本） */
export function readLedger(dir: string): ReadResult {
  const file = path.join(dir, 'messages.jsonl');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return { header: null, rows: [] };
  }
  let header: LedgerHeader | null = null;
  const rows: LedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 撕裂行跳过（append+fsync 下不该出现；防御读）
    }
    if ((parsed as { type?: string }).type === 'session-header') {
      header = parsed as LedgerHeader;
      continue;
    }
    rows.push(parsed as LedgerRow);
  }
  return { header, rows };
}

/** 读 journal 全量（partials.jsonl；缺席 = 空） */
export function readJournal(dir: string): JournalLine[] {
  const file = path.join(dir, 'journal', 'partials.jsonl');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: JournalLine[] = [];
  for (const line of text.split('\n')) {
    if (journalLineType(line) === null) continue;
    try {
      out.push(JSON.parse(line) as JournalLine);
    } catch {
      // 撕裂行跳过
    }
  }
  return out;
}

/** LLM 回放视图（viewer 投影：自己 = assistant，对端 = user） */
export interface ReplayMessage {
  role: 'assistant' | 'user' | 'system';
  content: string;
}

export type { ProjectedStep };

/**
 * journal → 指定 run 的 steps 投影（D4.2 终稿层带出：「webui 展开对方
 * 思考/工具内容时按 run 键直读 agent 账本 journal 带出」的读侧实现）。
 * 步行序 = 文件行序（= 模型消息数组实际序）；无 journal-settled 行 =
 * 中断/未收束 run → partial: true（前端渲染未完成态）；无步行 → null
 * （纯终稿 run 不挂 steps 键）。
 */
export function stepsOfRun(lines: JournalLine[], run: string): { steps: ProjectedStep[]; partial: boolean } | null {
  const facts = runFacts(lines, run);
  const steps: ProjectedStep[] = [];
  for (const line of facts.events) {
    if (line.type !== 'journal-step') continue;
    steps.push(projectStep(line, facts));
  }
  return steps.length === 0 ? null : { steps, partial: !facts.settled };
}

/** run 事实收集（stepsOfRun / segmentizeRun 共享）：收束态 + 结果补行索引
 *  + 子调用档案（按 seq 稳定序）+ 步行/注入行按真序。 */
interface RunFacts {
  settled: boolean;
  events: Array<JournalStep | JournalInject>;
  results: Map<string, { ok: boolean; output?: unknown; error?: string }>;
  /** 工具执行耗时索引（cr-766：journal-tool-result.durationMs——projectStep 合并进 toolCalls） */
  durations: Map<string, number>;
  /** 中止步集合（cr-766）：step 序号 → aborted——轨迹/续跑读侧剔除不完整 tool_calls 的判据 */
  abortedSteps: Set<number>;
  subcallsByHost: Map<string, Array<{ toolCallId: string; name?: string; arguments?: string; result: unknown; seq?: number }>>;
}

function runFacts(lines: JournalLine[], run: string): RunFacts {
  // 先收束态 + 结果补行索引（cr-596）：after-step 先于工具执行落步行
  //（副作用前 durable），结果以 journal-tool-result 补行到达——按
  // toolCallId 覆盖。settle 行在步之后，须先扫一遍再投步骤。
  let settled = false;
  const results = new Map<string, { ok: boolean; output?: unknown; error?: string }>();
  const durations = new Map<string, number>();
  const abortedSteps = new Set<number>();
  // 子调用档案（cr-597）：run_code 程序内子调用补行（subcall=true 携带
  // 名/参）——注入宿主 run_code 卡后平铺（主线 injectSubcalls 同义）
  const subcalls: Array<{ toolCallId: string; name?: string; arguments?: string; result: unknown; seq?: number }> = [];
  const events: Array<JournalStep | JournalInject> = [];
  for (const line of lines) {
    if (line.run !== run) continue;
    if (line.type === 'journal-settled') settled = true;
    if (line.type === 'journal-tool-result') {
      results.set(line.toolCallId, line.result);
      if (line.durationMs !== undefined) durations.set(line.toolCallId, line.durationMs);
      if (line.subcall === true) {
        subcalls.push({ toolCallId: line.toolCallId, name: line.name, arguments: line.arguments, result: line.result, seq: line.seq });
      }
    }
    if (line.type === 'journal-step' && line.aborted === true) abortedSteps.add(line.step);
    if (line.type === 'journal-step' || line.type === 'journal-inject') events.push(line);
  }
  // 真序 = 文件行序（append-only）：seq 在崩溃重启的 journal 里会归零重启
  //（writer 每实例从 1 起）——按 seq 排序会跨重启段交错，不做。
  // 宿主索引：子调用 toolCallId 形如 <宿主callId>#<seq>——首 # 前段即宿主
  const subcallsByHost = new Map<string, typeof subcalls>();
  for (const k of subcalls) {
    const hash = k.toolCallId.indexOf('#');
    if (hash <= 0) continue;
    const host = k.toolCallId.slice(0, hash);
    const bucket = subcallsByHost.get(host);
    if (bucket) bucket.push(k);
    else subcallsByHost.set(host, [k]);
  }
  return { settled, events, results, durations, abortedSteps, subcallsByHost };
}

/** 单步行 → ProjectedStep（补行覆盖 / 存量合成 / 子调用平铺 / ts 带出） */
function projectStep(line: JournalStep, facts: RunFacts): ProjectedStep {
  return {
    content: line.content,
    ...(line.ts !== undefined ? { ts: line.ts } : {}),
    ...(line.stepId !== undefined ? { stepId: line.stepId } : {}),
    ...(line.reasoning !== undefined ? { reasoning: line.reasoning } : {}),
    ...(line.aborted === true ? { aborted: true } : {}),
    ...(line.reasoningMs !== undefined ? { reasoningMs: line.reasoningMs } : {}),
    ...(line.textMs !== undefined ? { textMs: line.textMs } : {}),
    // 步级 API 计时/用量透传（cr-772）——历史链栏速率段数据源
    ...(line.elapsedMs !== undefined ? { elapsedMs: line.elapsedMs } : {}),
    ...(line.usage !== undefined ? { usage: line.usage } : {}),
    ...(line.toolCalls !== undefined && line.toolCalls.length > 0 ? {
      toolCalls: line.toolCalls.flatMap((tc, i) => {
        // 补行优先；步行自带 toolResults 兜底；已收束 run 两者皆缺 =
        // cr-596 前的存量步行（结果从未落盘）——合成空成功，不留给
        // 前端「永恒运行中」的假在途态；aborted 步的调用可能不完整
        // （参数 JSON 截断）——已收束（interrupted）视同合成空结果供 UI
        // 展示，续跑/轨迹面另经 abortedStepsOf 剔除
        const result = facts.results.get(tc.id) ?? line.toolResults?.[i]
          ?? (facts.settled ? { ok: true } : null);
        const dur = facts.durations.get(tc.id);
        const hostCard = {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          result,
          ...(dur !== undefined ? { durationMs: dur } : {}),
        };
        // 子调用平铺（cr-597）：宿主卡后按提交序（seq）注入子调用卡——
        // 宿主不在场（步行缺失/被吸收）的子调用如实丢弃（无渲染锚）
        const kids = facts.subcallsByHost.get(tc.id);
        if (kids === undefined) return [hostCard];
        kids.sort((a, b) => (a.seq ?? idTailSeq(a.toolCallId)) - (b.seq ?? idTailSeq(b.toolCallId)));
        return [hostCard, ...kids.map((k) => ({
          id: k.toolCallId,
          name: k.name ?? '(unknown)',
          arguments: k.arguments ?? '{}',
          result: k.result,
          subcall: true as const,
        }))];
      }),
    } : {}),
  };
}

/** 物化切段产物（cr-697）：'seg' = 段行 steps；'inj' = 注入行（切段点） */
export type RunSegment =
  | { kind: 'seg'; steps: ProjectedStep[] }
  | { kind: 'inj'; content: string; ts?: number; injectionId?: string; injectSource?: string; label?: string; requestId?: string };

/**
 * journal → run 物化切段（cr-697 settlement 段行物化的写侧纯函数）：
 * 步行/补行按 stepsOfRun 同款合并（结果覆盖、子调用平铺、settled 合成），
 * **注入行为切段点**（主线 settlement 切段语义）产出 [段, 注入行, 段, …]。
 * writer.settle / settleOrphan 据此落账段行；journal 随之剔除该 run 步行。
 */
export function segmentizeRun(lines: JournalLine[], run: string): RunSegment[] {
  const facts = runFacts(lines, run);
  const out: RunSegment[] = [];
  let cur: ProjectedStep[] = [];
  const closeSeg = (): void => {
    if (cur.length > 0) {
      out.push({ kind: 'seg', steps: cur });
      cur = [];
    }
  };
  for (const ev of facts.events) {
    if (ev.type === 'journal-inject') {
      closeSeg();
      out.push({
        kind: 'inj',
        content: ev.content,
        ...(ev.ts !== undefined ? { ts: ev.ts } : {}),
        ...(ev.requestId !== undefined ? { requestId: ev.requestId } : {}),
        ...(ev.injectionId !== undefined ? { injectionId: ev.injectionId } : {}),
        ...(ev.injectSource !== undefined ? { injectSource: ev.injectSource } : {}),
        ...(ev.label !== undefined ? { label: ev.label } : {}),
      });
      continue;
    }
    cur.push(projectStep(ev, facts));
  }
  closeSeg();
  return out;
}

/**
 * 账本段行 → run steps（cr-697 读侧：journal 收束即清后，settled run 的
 * steps 事实源 = 物化段行）。无段行 → null（消费方回落 journal 投影——
 * 存量会话 / in-flight run）。stepsOfLedger 与 stepsOfRun 同形，消费面零改动。
 */
export function stepsOfLedger(rows: LedgerRow[], run: string): { steps: ProjectedStep[]; partial: boolean } | null {
  // 行序 = 文件序（append-only 真序；seq 跨 writer 重启会归零，不排序）
  const steps = rows
    .filter((r) => r.run === run && r.source === 'segment' && Array.isArray(r.steps))
    .flatMap((r) => r.steps as ProjectedStep[]);
  return steps.length === 0 ? null : { steps, partial: false };
}

/**
 * 账本段行/注入行 → run 模型消息轨迹（cr-697：historyMessagesFor 的物化
 * 源——journal 收束即清后轨迹从段行重建；注入行 → user 消息）。与
 * trajectoryOfRun 同形（在途/存量 run 仍走 journal 侧）。无段行 → null。
 */
export function trajFromRows(rows: LedgerRow[], run: string): LlmMessage[] | null {
  // 行序 = 文件序（append-only 真序；seq 跨 writer 重启会归零，不排序）
  const runRows = rows.filter((r) => r.run === run && (r.source === 'segment' || r.source === 'inject'));
  if (runRows.length === 0) return null;
  const out: LlmMessage[] = [];
  for (const r of runRows) {
    if (r.source === 'inject') {
      out.push({ role: 'user', content: r.content });
      continue;
    }
    for (const s of r.steps ?? []) {
      // subcall 平铺卡（run_code 程序内子调用——cr-760）不进回放注入：
      // 模型真实所见只有宿主 run_code 调用对（返回值摘要），子调用是壳内
      // 编排细节（主线 injectSubcalls「默认不开——回放面纯净、KV 前缀
      // 不受污染」裁决同款）。物化段行 steps 的 toolCalls 混有平铺卡，展开
      // 前过滤。
      const calls = (s.toolCalls ?? []).filter((tc) => tc.subcall !== true && (tc.id || tc.name));
      out.push({
        role: 'assistant',
        content: s.content,
        ...(calls.length > 0 ? {
          tool_calls: calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } : {}),
      });
      for (const tc of calls) {
        out.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(tc.result ?? { ok: true }) });
      }
    }
  }
  return out;
}

/**
 * journal → run 的模型消息轨迹（cr-658 轨迹完整性读侧重建）：步行/注入
 * 行按 seq 序重建为 LlmMessage[]——assistant{content, tool_calls} +
 * tool{tool_call_id, content} 协议对 + steer 注入的 user 行。与 stepsOfRun
 * 的 UI 投影分职：本函数产物直接进 run 上下文（historyMessagesFor 消费），
 * 协议合法性优先——无结果的 toolCall（未提交步：after-step 副作用前先落、
 * 结果补行未达）整调用剔除，剔除后 content 与 toolCalls 双空的步整步跳过；
 * 已收束 run 的存量缺结果（cr-596 前步行）按 stepsOfRun 同款合成空成功。
 * 子调用补行（runCodeSubcall——宿主卡内展示用）不产生独立模型消息，跳过。
 */
export function trajectoryOfRun(lines: JournalLine[], run: string): LlmMessage[] {
  let settled = false;
  const results = new Map<string, { ok: boolean; output?: unknown; error?: string }>();
  for (const line of lines) {
    if (line.run !== run) continue;
    if (line.type === 'journal-settled') settled = true;
    if (line.type === 'journal-tool-result' && line.subcall !== true) results.set(line.toolCallId, line.result);
  }
  const events = lines
    .filter((l): l is JournalStep | JournalInject => l.run === run && (l.type === 'journal-step' || l.type === 'journal-inject'))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const out: LlmMessage[] = [];
  for (const ev of events) {
    if (ev.type === 'journal-inject') {
      out.push({ role: 'user', content: ev.content });
      continue;
    }
    // 中止步（cr-766）：tool_calls 可能不完整（参数 JSON 截断）且从未
    // 执行——整调用剔除（区别于崩溃窗口的 UNCOMMITTED 合成：aborted =
    // 明确未执行，不是结果未知）；部分正文如实保留。
    if (ev.aborted === true) {
      if (ev.content.trim() !== '') out.push({ role: 'assistant', content: ev.content });
      continue;
    }
    const calls = (ev.toolCalls ?? [])
      .map((tc, i) => ({ tc, result: results.get(tc.id) ?? ev.toolResults?.[i] ?? (settled ? { ok: true } : null) }))
      .filter((c): c is { tc: { id: string; name: string; arguments: string }; result: { ok: boolean; output?: unknown; error?: string } } => c.result !== null);
    if (ev.content.trim() === '' && calls.length === 0) continue;
    out.push({
      role: 'assistant',
      content: ev.content,
      ...(calls.length > 0 ? {
        tool_calls: calls.map(({ tc }) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } : {}),
    });
    for (const { tc, result } of calls) {
      out.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return out;
}

/**
 * 未提交工具调用的合成结果（cr-667，A1 续跑）：崩溃窗口内调用可能已执行
 * 也可能未执行——盲目重执行 = 副作用重复，丢弃 = 模型失忆，「结果未知」
 * 是唯一诚实状态（设计裁决：v1 不做 at-least-once 重执行，幂等白名单归 v2）。
 */
export const UNCOMMITTED_TOOL_ERROR = '壳在该调用执行中崩溃，是否已产生副作用未确认——请先核查（如重读文件/查进程）再决定是否重做。';

/**
 * 续跑上下文重建（cr-667，A1）：trajectoryOfRun 的续跑变体——不再「无结果
 * 整调用剔除」，未提交调用（步行在、结果补行缺）保留 tool_calls 并以
 * UNCOMMITTED_TOOL_ERROR 合成 tool 消息（协议对完整，模型拿到明确信号）。
 * committedSteps = 全调用已提交的步数（maxSteps 剩余额度基数）。run 无
 * 步行/注入行 → null（无可续跑轨迹）。
 */
export function resumeContextOfRun(
  lines: JournalLine[],
  run: string,
): { messages: LlmMessage[]; committedSteps: number } | null {
  const results = new Map<string, { ok: boolean; output?: unknown; error?: string }>();
  for (const line of lines) {
    if (line.run !== run) continue;
    if (line.type === 'journal-tool-result' && line.subcall !== true) results.set(line.toolCallId, line.result);
  }
  const events = lines
    .filter((l): l is JournalStep | JournalInject => l.run === run && (l.type === 'journal-step' || l.type === 'journal-inject'))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const out: LlmMessage[] = [];
  let committedSteps = 0;
  for (const ev of events) {
    if (ev.type === 'journal-inject') {
      out.push({ role: 'user', content: ev.content });
      continue;
    }
    // 中止步（cr-766）：调用从未执行且参数可能截断——整调用剔除（不合成
    // UNCOMMITTED——那是崩溃窗口「结果未知」的语义；aborted 是明确未
    // 执行）。部分正文如实保留（携带面），不计入 committedSteps。
    if (ev.aborted === true) {
      if (ev.content.trim() !== '') out.push({ role: 'assistant', content: ev.content });
      continue;
    }
    const calls = (ev.toolCalls ?? []).map((tc, i) => ({ tc, result: results.get(tc.id) ?? ev.toolResults?.[i] ?? null }));
    if (ev.content.trim() === '' && calls.length === 0) continue;
    if (calls.length > 0 && calls.every((c) => c.result !== null)) committedSteps += 1;
    out.push({
      role: 'assistant',
      content: ev.content,
      ...(calls.length > 0 ? {
        tool_calls: calls.map(({ tc }) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })),
      } : {}),
    });
    for (const { tc, result } of calls) {
      out.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result ?? { ok: false, error: UNCOMMITTED_TOOL_ERROR }) });
    }
  }
  return out.length === 0 ? null : { messages: out, committedSteps };
}

/**
 * 孤儿 run 扫描（cr-628 web-ui 孤儿投影）：journal 里有步行/注入行但无
 * journal-settled 标记的 run id（壳死于 mid-run——既无 viewer run 键行可
 * 联、又无 settled 可判收束，读侧此前整 run 蒸发）。新壳 boot 的
 * recoverOrphanRuns 补 settled 后此面自然清空（存量旧 journal 仍可见）。
 */
export function orphanRunsOf(lines: JournalLine[]): string[] {
  const settled = new Set<string>();
  const candidates = new Set<string>();
  for (const line of lines) {
    if (line.run === '') continue;
    if (line.type === 'journal-settled') settled.add(line.run);
    else if (line.type === 'journal-step' || line.type === 'journal-inject') candidates.add(line.run);
  }
  return [...candidates].filter((run) => !settled.has(run));
}

/** 子调用 toolCallId 尾段序数（<hostId>#<seq> 的 seq——无 seq 存量回退） */
function idTailSeq(toolCallId: string): number {
  const hash = toolCallId.indexOf('#');
  const tail = Number(hash > 0 ? toolCallId.slice(hash + 1) : NaN);
  return Number.isFinite(tail) ? tail : 0;
}

/** 会话概要（会话目录 summary.md——归档写、回放读，同源单文件） */
export function summaryTextOf(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, 'summary.md'), 'utf-8').trim();
  } catch {
    return '';
  }
}

export function replayView(rows: LedgerRow[], viewer: string): ReplayMessage[] {
  return rows
    // 空 content 行不入注入（中断/空收束行——注入与归档估算同源过滤）；
    // 段行（content 恒空）/注入行（cr-697 物化产物——归 trajectory 读面按
    // 步重建）不进文本投影
    .filter((r) => r.role === 'agent' && r.content.trim() !== ''
      && r.source !== 'segment' && r.source !== 'inject')
    .map((r) => ({
      role: r.agent_id === viewer ? 'assistant' : 'user',
      content: r.content,
    }));
}
