// ============================================================
// reader.ts —— 账本读面（宿主 webui 只读投影 / 回放；壳侧 run 前重读）
//
// viewer 投影内建于行协议：agent_id === viewer → assistant 视角，
// 否则 user/对端视角（D4.2 最大现状复用——own/peer 投影通例）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type LedgerRow, type LedgerHeader, type JournalLine, type JournalStep, type JournalInject, type JournalToolResult, type ProjectedStep } from './records.ts';
import type { LlmMessage } from 'ac-llm';

interface ReadResult {
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
    // cr-978 注记：早期子 Agent 会话写面落过缺 message_id/timestamp 的裸行
    //（role/content/agent_id/uuid）——读侧不突变行形状（所有读面共用），
    // 消费容错归 projectUserReplay 判别面（idKeyOf / 可选链守卫）。
    rows.push(parsed as LedgerRow);
  }
  return { header, rows };
}

/** 行类型判别（读侧路由——readJournal 读过滤私有） */
function journalLineType(line: string): 'step' | 'inject' | 'tool-result' | 'settled' | null {
  const t = line.trimStart();
  if (t.startsWith('{"type":"journal-step"')) return 'step';
  if (t.startsWith('{"type":"journal-inject"')) return 'inject';
  if (t.startsWith('{"type":"journal-tool-result"')) return 'tool-result';
  if (t.startsWith('{"type":"journal-settled"')) return 'settled';
  return null;
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

/**
 * 读子调用永久档案（subcalls.jsonl——cr-803 分流产物；缺席 = 空）。
 * 行 = journal-tool-result 补行原样（subcall:true + name/arguments/result）。
 */
export function readSubcalls(dir: string): JournalToolResult[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'subcalls.jsonl'), 'utf-8');
  } catch {
    return [];
  }
  const out: JournalToolResult[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{"type":"journal-tool-result"')) continue;
    try {
      out.push(JSON.parse(line) as JournalToolResult);
    } catch {
      // 撕裂行跳过
    }
  }
  return out;
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
  /** 收束形态（C3 合成收尾）：journal-settled.finish——interrupted 时无结果
   *  调用按 aborted 步（未开始）/ 完整步（结果未知）合成确定性终态 */
  finish?: 'ok' | 'interrupted' | 'error';
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
  let finish: RunFacts['finish'];
  for (const line of lines) {
    if (line.run !== run) continue;
    if (line.type === 'journal-settled') {
      settled = true;
      finish = line.finish;
    }
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
  // 真序 = 文件行序（append-only）。B1 起 writer 打开时扫尾行续接 max(seq)，
  // seq 已跨 writer 实例单调不回退（「每实例从 1 起」的归零段不复存在）；
  // 行序仍是权威——seq 只作身份锚/水位用，不承担重排职责（历史文件里
  // 存量归零段仍在，按 seq 排序对存量会交错，继续不做）。
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
  return { settled, finish, events, results, durations, abortedSteps, subcallsByHost };
}

/** 单步行 → ProjectedStep（补行覆盖 / 存量合成 / 子调用平铺 / ts 带出）。
 *  opts.subcalls = false（cr-803 物化形态）：跳过子调用平铺——段行不含
 *  subcall 卡（档案分流 subcalls.jsonl），UI 平铺改由读侧 stepsOfLedger
 *  联查注入。 */
function projectStep(line: JournalStep, facts: RunFacts, opts: { subcalls?: boolean } = {}): ProjectedStep {
  return {
    content: line.content,
    ...(line.ts !== undefined ? { ts: line.ts } : {}),
    ...(line.stepId !== undefined ? { stepId: line.stepId } : {}),
    // B2 步级 seq 保留：journal 步行 seq 随步透传（存量行缺席）
    ...(line.seq !== undefined ? { seq: line.seq } : {}),
    ...(line.reasoning !== undefined ? { reasoning: line.reasoning } : {}),
    // 步内相位序（cr-946 / cr-804 回归）：物化段行与读面同步透传——前端
    // 历史回放的「正文/工具卡」相对序契约。
    ...(line.textBeforeTools !== undefined ? { textBeforeTools: line.textBeforeTools } : {}),
    ...(line.aborted === true ? { aborted: true } : {}),
    ...(line.reasoningMs !== undefined ? { reasoningMs: line.reasoningMs } : {}),
    ...(line.textMs !== undefined ? { textMs: line.textMs } : {}),
    // 步级 API 计时/用量透传（cr-772）——历史链栏速率段数据源
    ...(line.elapsedMs !== undefined ? { elapsedMs: line.elapsedMs } : {}),
    ...(line.usage !== undefined ? { usage: line.usage } : {}),
    ...(line.toolCalls !== undefined && line.toolCalls.length > 0 ? {
      toolCalls: line.toolCalls.flatMap((tc, i) => {
        // 补行优先；步行自带 toolResults 兜底；已收束 run 两者皆缺——
        // C3 合成收尾（对齐 DSH repair 思想：「合不上」从运行时竞态变成
        // 恢复时确定性计算）：
        //   · finish=ok（含 cr-596 前存量步行）→ 合成空成功，不留给前端
        //     「永恒运行中」的假在途态；
        //   · finish=interrupted + aborted 步 → 调用未开始，合成
        //     TOOL_NOT_STARTED（LLM 流被 abort，参数可能截断、从未执行）；
        //   · finish=interrupted + 完整步 → 工具已发出但结果未回，合成
        //     TOOL_OUTCOME_UNKNOWN（副作用是否已产生不确定——与
        //     resumeContextOfRun 的 UNCOMMITTED_TOOL_ERROR 同语义的 UI 面）。
        // UI 兜底链（spinHold/悬挂探针）对此降级为纯保险。
        const synth = facts.finish === 'interrupted'
          ? (facts.abortedSteps.has(line.step)
              ? { ok: false, error: 'TOOL_NOT_STARTED' }
              : { ok: false, error: 'TOOL_OUTCOME_UNKNOWN' })
          : { ok: true };
        const result = facts.results.get(tc.id) ?? line.toolResults?.[i]
          ?? (facts.settled ? synth : null);
        const dur = facts.durations.get(tc.id);
        const hostCard = {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          result,
          ...(dur !== undefined ? { durationMs: dur } : {}),
        };
        // 子调用平铺（cr-597）：宿主卡后按提交序（seq）注入子调用卡——
        // 宿主不在场（步行缺失/被吸收）的子调用如实丢弃（无渲染锚）。
        // cr-803 物化形态关平铺（档案独立落盘，读面联查）
        const kids = opts.subcalls === false ? undefined : facts.subcallsByHost.get(tc.id);
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

/**
 * 账本段行 → run steps（cr-697 读侧：journal 收束即清后，settled run 的
 * steps 事实源 = 物化段行）。无段行 → null（消费方回落 journal 投影——
 * 存量会话 / in-flight run）。stepsOfLedger 与 stepsOfRun 同形，消费面零改动。
 *
 * subcalls（cr-803）：subcalls.jsonl 档案行在场时联查注入——段行不含
 * subcall 平铺卡（物化剥离），宿主卡后按提交序复原 UI 平铺。存量段行
 * （cr-803 前物化、已内联平铺卡）天然防重：宿主已有 subcall 卡即跳过。
 */
export function stepsOfLedger(rows: LedgerRow[], run: string, subcalls?: JournalToolResult[]): { steps: ProjectedStep[]; partial: boolean } | null {
  // 行序 = 文件序（append-only 真序；seq 跨 writer 重启会归零，不排序）
  const segRows = rows.filter((r) => r.run === run && r.source === 'segment' && Array.isArray(r.steps));
  if (segRows.length === 0) return null;
  const steps = segRows.flatMap((r) => r.steps as ProjectedStep[]);
  if (subcalls !== undefined && subcalls.length > 0) injectSubcallCards(steps, subcalls);
  return { steps, partial: false };
}

/** 档案子调用卡 → 宿主卡后注入（cr-803 读侧平铺复原；宿主缺席如实丢弃
 *  ——无渲染锚，与 journal 投影同语义）。存量内联形态防重：宿主卡组内
 *  已含 subcall 卡即整组跳过。 */
export function injectSubcallCards(steps: ProjectedStep[], subcalls: JournalToolResult[]): void {
  const byHost = new Map<string, JournalToolResult[]>();
  for (const k of subcalls) {
    // 旧轨道存量档案行宽容：toolCallId 缺席/无 # 前缀（无宿主锚）跳过
    if (typeof k.toolCallId !== 'string') continue;
    const hash = k.toolCallId.indexOf('#');
    if (hash <= 0) continue;
    const host = k.toolCallId.slice(0, hash);
    const bucket = byHost.get(host);
    if (bucket !== undefined) bucket.push(k);
    else byHost.set(host, [k]);
  }
  for (const s of steps) {
    if (s.toolCalls === undefined) continue;
    for (let i = 0; i < s.toolCalls.length; i++) {
      const group = [s.toolCalls[i]!];
      let j = i + 1;
      while (j < s.toolCalls.length && s.toolCalls[j]!.subcall === true) { group.push(s.toolCalls[j]!); j++; }
      const kids = byHost.get(s.toolCalls[i]!.id);
      if (kids === undefined) { i = j - 1; continue; }
      if (group.length > 1) { i = j - 1; continue; } // 存量内联防重
      kids.sort((a, b) => (a.seq ?? idTailSeq(a.toolCallId)) - (b.seq ?? idTailSeq(b.toolCallId)));
      s.toolCalls.splice(i + 1, 0, ...kids.map((k) => ({
        id: k.toolCallId,
        name: k.name ?? '(unknown)',
        arguments: k.arguments ?? '{}',
        result: k.result,
        subcall: true as const,
      })));
      i += kids.length;
    }
  }
}

/**
 * 未提交工具调用的合成结果（cr-667，A1 续跑）：崩溃窗口内调用可能已执行
 * 也可能未执行——盲目重执行 = 副作用重复，丢弃 = 模型失忆，「结果未知」
 * 是唯一诚实状态（设计裁决：v1 不做 at-least-once 重执行，幂等白名单归 v2）。
 */
export const UNCOMMITTED_TOOL_ERROR = '壳在该调用执行中崩溃，是否已产生副作用未确认——请先核查（如重读文件/查进程）再决定是否重做。';

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
