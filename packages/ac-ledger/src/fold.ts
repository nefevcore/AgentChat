// ============================================================
// fold.ts —— fold 壳（cr-1245 B1：纯核〔谓词族 + foldStepsOf + foldUserReplay
// + SessionFold 合并模型〕迁 ac-ledger-core fold-core.ts；本文件保留 fs 面
//（foldSession/foldViewRecords/foldLlmReplay）+ 全量 re-export——出口面不变）。
// ============================================================
import type { LlmMessage } from 'ac-llm';
import { readSubcalls } from './reader.ts';
import { sessionDir } from './writer.ts';
import { pairIncludes } from 'ac-conv-keys'; // 会话键词法单源（cr-1238 B3）
import { readDomainFacts, type DomainFacts, type RunFactsV2, type SpeechEvent, type ContextEvent, type StepMeter } from './events-v2.ts';
import { conversationDirs } from './manage.ts';
import type { JournalToolResult, LedgerAttachment, ProjectedStep } from './records.ts';
import type { UserReplayRow } from './user.ts';
import { UNCOMMITTED_TOOL_ERROR } from './reader.ts';
import { wrapForReplay, REPLAY_BUILTIN_NONE, type ReplayKind } from './replay.ts';
import type { ViewRow } from './view.ts';
// cr-1245 B1：纯核 re-export（消费方 import 路径不变）
export {
  foldStepsOf, foldFromFacts, emptyFold, rowShadowedBy,
  foldDigestOf, foldUserReplay, foldTextReplay, ARCHIVE_SUMMARY_SOURCE,
  type SessionFold,
} from 'ac-ledger-core/src/fold-core.ts';
import { foldStepsOf, rowShadowedBy, foldDigestOf, foldUserReplay, emptyFold, foldFromFacts, type SessionFold } from 'ac-ledger-core/src/fold-core.ts';
// foldStepsOf 依赖注入卡（core reader-core）——壳内继续可用
import { injectSubcallCards } from 'ac-ledger-core/src/reader-core.ts';

/** 活跃 run 聚集行（view.ts RunningEntry 同形——配平门控输入；异名避免导出冲撞） */
export interface FoldRunningEntry {
  agentId: string;
  conversationId: string;
  runId: string | null;
}

export interface FoldViewOptions {
  view?: 'chat' | 'plain' | 'lite';
  running?: FoldRunningEntry[];
  subcallsOf?: (domain: string, run: string) => JournalToolResult[] | undefined;
}

export function foldSession(dataRoot: string, conversationId: string, dirs?: string[]): SessionFold {
  const list = dirs ?? conversationDirs(dataRoot, conversationId, { includeJournalOnly: true });
  const fold = emptyFold();
  for (const dir of list) {
    foldFromFacts(fold, readDomainFacts(dir, domainOfDir(dir)));
  }
  fold.speech.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return fold;
}

/** 会话目录 → 域名（agents/<domain>/sessions/<uuid> 与 viewer/sessions/<uuid> 同推导） */
function domainOfDir(dir: string): string {
  const parts = dir.split(/[\\/]/);
  return parts.at(-3) ?? '';
}


// —— 投影二：webui 视图（assembleSessionView 语义） ——

const LITE_FIELD_MAX = 2 * 1024;

function clipField(s: string): string {
  return s.slice(0, LITE_FIELD_MAX) + '…[+' + (s.length - LITE_FIELD_MAX) + 'B 截断]';
}

function liteProjectStep(step: ProjectedStep): ProjectedStep {
  let reasoning = step.reasoning;
  if (typeof reasoning === 'string' && reasoning.length > LITE_FIELD_MAX) reasoning = clipField(reasoning);
  const toolCalls = step.toolCalls?.map((tc) => {
    const next = { ...tc };
    if (typeof tc.arguments === 'string' && tc.arguments.length > LITE_FIELD_MAX) next.arguments = clipField(tc.arguments);
    const resultStr = JSON.stringify(tc.result);
    if (resultStr.length > LITE_FIELD_MAX) {
      (next as { resultTruncated?: boolean }).resultTruncated = true;
      next.result = { truncated: true, size: resultStr.length, preview: resultStr.slice(0, 200) };
    }
    return next;
  });
  return { ...step, ...(reasoning !== undefined ? { reasoning } : {}), ...(toolCalls !== undefined ? { toolCalls } : {}) };
}

function liteRow(r: ViewRow): ViewRow {
  if (!Array.isArray(r.steps)) return r;
  return { ...r, steps: (r.steps as ProjectedStep[]).map(liteProjectStep) };
}

export function foldViewRecords(fold: SessionFold, dataRoot: string, conversationId: string, opts: FoldViewOptions = {}): ViewRow[] {
  // cr-1133:viewer 端点域判定——对桶键 <agent>~<viewer> 中 'user' 端点的域目录
  //（agents/user）是存量镜像域：speech 镜像行进终稿层（正文事实），但 run 事实
  //（journal）是镜像/迁移产物，webui 视图不重投（正主在 agent 域或已过时）。
  const viewerEndpoint = pairIncludes(conversationId, 'user') ? 'user' : null;
  // subcall 档案取值：索引钩子优先（D-1——按 run 定位 seek）；回落惰性全读
  const subcallCache = new Map<string, JournalToolResult[]>();
  const subcallsFor = (domain: string, run: string): JournalToolResult[] => {
    const viaIndex = opts.subcallsOf?.(domain, run);
    if (viaIndex !== undefined) return viaIndex;
    let list = subcallCache.get(domain);
    if (list === undefined) {
      list = readSubcalls(sessionDir(dataRoot, domain, conversationId));
      subcallCache.set(domain, list);
    }
    return list;
  };
  const stepsFor = (domain: string, run: string): { steps: ProjectedStep[]; partial: boolean } | null => {
    const rf = fold.runs.get(run);
    if (rf === undefined) return null;
    return foldStepsOf(rf, subcallsFor(domain, run));
  };
  const replay = foldUserReplay(fold);
  // 注入卡归口（run 键）
  const injectRowsOf = new Map<string, ViewRow[]>();
  const seenInjectAnchors = new Set<string>();
  const viewerOwnRequestIds = new Set<string>();
  for (const r of replay) {
    if (r.role === 'user' && r.requestId !== undefined) viewerOwnRequestIds.add(r.requestId);
  }
  const projectInject = (run: string, row: ViewRow): void => {
    const anchor = String(row.message_id);
    if (seenInjectAnchors.has(anchor)) return;
    seenInjectAnchors.add(anchor);
    const req = row.requestId;
    if (typeof req === 'string' && req !== '' && viewerOwnRequestIds.has(req)) return;
    const bucket = injectRowsOf.get(run) ?? [];
    bucket.push(row);
    injectRowsOf.set(run, bucket);
  };
  for (const c of fold.contexts) {
    // cr-1110:恒等化写法修正(原 source==='inject'||source!=='error' 前项永真)
    // ——实际语义:非 error 的带 run 键 context 行进 run 归口;error 走尾段红条,
    // 无 run 键行走尾段直落。数据面透传判据在前端(historyApi 数据面在场)。
    if (c.source === 'error' || c.run === undefined) continue;
    projectInject(c.run, {
      role: 'context',
      content: c.content,
      ...(c.label !== undefined ? { label: c.label } : c.source !== 'inject' && c.source !== 'event' ? { label: c.source } : {}),
      ...(c.payload !== undefined ? { payload: c.payload } : {}),
      bytes: c.content.length, // cr-1109:bytes 投影派生(与直播帧 content.length 定义恒等)——前端兜底链 parity 前提
      source: c.injectSource ?? (c.source !== 'event' && c.source !== 'inject' ? c.source : 'inject'),
      message_id: c.messageId,
      timestamp: c.timestamp,
      agent_id: c.agentId,
      run: c.run,
      ...(c.requestId !== undefined ? { requestId: c.requestId } : {}),
      ...(c.seq !== undefined ? { seq: c.seq } : {}),
    });
  }
  for (const rf of fold.runs.values()) {
    for (const ev of rf.events) {
      if (ev.kind !== 'inject') continue;
      projectInject(ev.run, {
        role: 'context',
        content: ev.content,
        ...(ev.label !== undefined ? { label: ev.label } : {}),
        ...(ev.payload !== undefined ? { payload: ev.payload } : {}),
        bytes: ev.content.length, // cr-1109:bytes 投影派生
        source: ev.injectSource ?? 'inject',
        message_id: ev.injectionId ?? 'jinj-' + ev.run + '-' + (ev.seq ?? 0),
        timestamp: new Date(ev.ts || Date.now()).toISOString(),
        agent_id: rf.domain,
        run: ev.run,
        ...(ev.requestId !== undefined ? { requestId: ev.requestId } : {}),
        ...(ev.seq !== undefined ? { seq: ev.seq } : {}),
      });
    }
  }
  // 终稿层主投影
  const all: ViewRow[] = [];
  const viewerRuns = new Set<string>();
  // cr-1133:run → 账本行归属（盲区行 agent_id 正源——镜像域 run 事实的 domain
  // 是镜像端点不是发言者；同 run 的账本 speech 行 agentId 才是真实归属）
  const speechAgentOfRun = new Map<string, string>();
  for (const s of fold.speech) {
    const r0 = s.run ?? s.sourceRun;
    if (r0 !== undefined && !speechAgentOfRun.has(r0) && s.agentId !== viewerEndpoint) speechAgentOfRun.set(r0, s.agentId);
  }
  for (const r of replay) {
    const projected = r.role === 'peer' && r.run !== undefined ? stepsFor(r.agentId, r.run) : null;
    if (r.run !== undefined) {
      viewerRuns.add(r.run);
      all.push(...(injectRowsOf.get(r.run) ?? []));
    }
    all.push({
      role: r.role === 'peer' ? 'assistant' : 'user',
      agent_id: r.role === 'peer' ? r.agentId : undefined,
      content: r.content,
      timestamp: r.timestamp,
      // cr-1132:发言行 message_id 升格携带——anchor 锚目标(注入卡挂靠)
      ...(r.messageId ? { message_id: r.messageId } : {}),
      ...(r.run !== undefined ? { run: r.run } : {}),
      // cr-1286 P4-1:轮身份键——peer 行 = run(无 run 回落 message_id);user 行 =
      // message_id(用户轮独立成轮;老形态 run 键覆盖对话边界的场景 run 优先)
      ...(r.run ?? r.messageId ? { turnId: r.run ?? r.messageId } : {}),
      ...(r.runMs !== undefined ? { runMs: r.runMs } : {}),
      ...(r.seq !== undefined ? { seq: r.seq } : {}),
      ...(projected !== null ? { steps: projected.steps, ...(projected.partial ? { partial: true } : {}) } : {}),
    });
  }
  // 活投影（runId 精确门控）
  const runningHere = (opts.running ?? [])
    .flatMap((r) => r.conversationId === conversationId && r.runId !== null ? [{ agentId: r.agentId, runId: r.runId }] : []);
  for (const run0 of runningHere) {
    const rf = fold.runs.get(run0.runId);
    if (rf === undefined) continue;
    const p = foldStepsOf(rf, subcallsFor(run0.agentId, run0.runId));
    if (p === null || !p.partial) continue;
    all.push(...(injectRowsOf.get(run0.runId) ?? []));
    for (const s of p.steps) {
      all.push({ role: 'assistant', agent_id: run0.agentId, content: '', run: run0.runId, steps: [s], partial: true, turnId: run0.runId, ...(typeof s.ts === 'number' && s.ts > 0 ? { timestamp: new Date(s.ts).toISOString() } : {}) });
    }
  }
  // 盲区投影（cr-628/698）+ 配平（D-3：未闭合 run 投 partial——不回写）
  const runningIds = new Set(runningHere.map((r) => r.runId));
  for (const [run, rf] of fold.runs) {
    const hasFacts = rf.events.length > 0 || rf.aggregated !== undefined;
    if (!hasFacts || viewerRuns.has(run) || runningIds.has(run)) continue;
    // cr-1133:盲区行归属 = 同 run 账本行的真实 agentId（优先）——镜像域
    //（agents/user）journal 的 run 事实曾以 rf.domain='user' 投出 assistant 行，
    // 前端按 viewer 渲染成 user 气泡（neko~user「谢谢喵」/admin~user「明白了——」
    // 串台实锤）。账本 speech 行的 agentId 是发言归属正源；缺席回落 rf.domain。
    // migrated 伪 run（无任何账本行锚 + 住 viewer 端点域）不投——迁移工具把
    // 历史消息造成的伪 run，正文已由真实消息行承载，重投即串台。
    if (viewerEndpoint !== null && rf.domain === viewerEndpoint && !speechAgentOfRun.has(run)) continue;
    const ledgerOwner = speechAgentOfRun.get(run) ?? rf.domain;
    const p = foldStepsOf(rf, subcallsFor(rf.domain, run));
    if (p === null) continue;
    // 末事实 ts（foldLlmReplay 孤儿 slot 同源）——时间全序位次锚
    let lastTs = 0;
    for (const ev of rf.events) {
      if (ev.kind === 'tool-call-result') continue;
      if ((ev.ts ?? 0) > lastTs) lastTs = ev.ts ?? 0;
    }
    if (rf.aggregated !== undefined) for (const s of rf.aggregated) if ((s.ts ?? 0) > lastTs) lastTs = s.ts ?? 0;
    // cr-1134 续:已收束但无任何 ts 事实的孤儿 run 不投（foldLlmReplay 孤儿
    // slot 同判据「无 ts 事实——无锚不插」）——迁移 journal 的存量步无 ts 字段，
    // 盲区投出后排序守尾 + 无锚不去重，与真实终稿（另一 run 键承载同内容）双投，
    // 且 toHistoryMessages 缺 ts 继承后继=恒在会话末（live「agent 侧幻影」形态）。
    // 正主内容由带锚终稿行承载。在途 run（无 end）不受此限——活投影语义优先。
    if (lastTs <= 0 && rf.end !== undefined) continue;
    all.push(...(injectRowsOf.get(run) ?? []));
    all.push({
      role: 'assistant',
      agent_id: ledgerOwner,
      content: '',
      run,
      // cr-1286 P4-1:盲区行轮身份键 = run
      turnId: run,
      steps: p.steps,
      ...(p.partial ? { partial: true } : {}),
      ...(lastTs > 0 ? { timestamp: new Date(lastTs).toISOString() } : {}),
    });
  }
  // 尾段行族（cr-1132 时间全序契约）：error 红条 / 直落 context / 机制
  // event 分隔符并入主时间线 slot 归并（ts 主序 + 收集序 tiebreak）——
  // 分页窗口 = 时间窗（web-api slice 不改自动变对）。锚定派生也在全序
  // 时间线上完成（后述）。
  const errRows: ViewRow[] = [];
  for (const c of fold.contexts) {
    if (c.source === 'error') {
      errRows.push({
        role: 'error', agent_id: c.agentId, content: c.content, message_id: c.messageId,
        timestamp: c.timestamp, run: c.run, ...(c.seq !== undefined ? { seq: c.seq } : {}),
      });
    }
  }
  const dropRows: ViewRow[] = [];
  for (const c of fold.contexts) {
    if (c.source === 'event' || c.source === 'error' || c.run !== undefined) continue;
    dropRows.push({
      role: 'context', content: c.content,
      label: c.label ?? c.source, source: c.source,
      message_id: c.messageId, timestamp: c.timestamp,
      // cr-1132:viewer 域（agents/user）恒值归属归一为无归属——v1 存量
      // 直落行的 agent_id='user' 是落账恒值不承载归属语义,前端曾当真实
      // 归属参与挂轮判定(实锤失败链)。落盘不动,读侧归一。
      ...(c.domain === 'user' ? {} : { agent_id: c.agentId }),
      bytes: c.content.length, // cr-1109:bytes 投影派生
      ...(c.seq !== undefined ? { seq: c.seq } : {}),
    });
  }
  // 机制通知行（cr-946）：event 分隔符——现行 context+event 行与 cr-946 前
  // 存量落形（speech 行 agent_id='user' + restarted-*）
  const eventRows: ViewRow[] = [];
  for (const r of fold.speech) {
    if (r.agentId === 'user' && r.requestId !== undefined && r.requestId.startsWith('restarted-')) {
      eventRows.push({
        role: 'event', agent_id: r.domain, content: r.content, message_id: r.messageId,
        timestamp: r.timestamp, source: 'event', requestId: r.requestId,
        ...(r.seq !== undefined ? { seq: r.seq } : {}),
      });
    }
  }
  for (const c of fold.contexts) {
    if (c.source === 'event' && c.run === undefined) {
      eventRows.push({
        role: 'event', agent_id: c.agentId, content: c.content, message_id: c.messageId,
        timestamp: c.timestamp, source: 'event', ...(c.requestId !== undefined ? { requestId: c.requestId } : {}),
        ...(c.seq !== undefined ? { seq: c.seq } : {}),
      });
    }
  }
  const tailContextRows: ViewRow[] = [];
  // cr-1134:run 归口注入卡残留回落——带 run 键的 context 行进归口桶后，只在
  // 「该 run 的主投影行」出现时随行投出；run 有 run-end 却无终稿行（机制 run /
  // 死窗口）时桶内容永不可见（memory-delta 等注入卡整类缺席的根因）。
  // 已消费 run = 终稿层 run ∪ 活投影 run ∪ 盲区投出的 run；其余桶按直落卡投出。
  const consumedRuns = new Set<string>(viewerRuns);
  for (const r of runningHere) consumedRuns.add(r.runId);
  for (const [run, rf] of fold.runs) {
    const hasFacts = rf.events.length > 0 || rf.aggregated !== undefined;
    if (hasFacts && viewerEndpoint !== null && rf.domain === viewerEndpoint && !speechAgentOfRun.has(run)) consumedRuns.add(run);
  }
  for (const [run, rows] of injectRowsOf) {
    if (consumedRuns.has(run)) continue;
    for (const row of rows) tailContextRows.push(row);
  }
  // —— 时间全序归并（foldLlmReplay 同款稳定语义——输入序 tiebreak）——
  // 主投影（终稿层 + run 归口注入 + 活投影 + 盲区）与尾段三族一体按 ts
  // 稳定排序：同刻保持输入序（主投影行先于尾段行；错误行晚于收束、
  // event 行按文件序）。无 ts 行（极端存量）守尾不参与乱序。
  const sortKey = (r: ViewRow): string => {
    const t = String(r.timestamp ?? '');
    return t === '' ? '\uffff' : t;
  };
  const merged = [...all, ...errRows, ...dropRows, ...eventRows, ...tailContextRows]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ka = sortKey(a.r);
      const kb = sortKey(b.r);
      return ka !== kb ? (ka < kb ? -1 : 1) : a.i - b.i;
    })
    .map((e) => e.r);
  // —— anchor 派生（cr-1132：无 run 锚直落卡的时间线锚定——投影层全会话
  // 视野完成，前端不再窗口局部猜测）——
  // 锚 = 时间线上最近后续 agent 发言行 message_id（无后续则前向最近 agent
  // 行；全会话无 agent 发言行 → 无锚，前端降级卡）。发言行投影升格携带
  // message_id（增量字段，不迁数据）。v1 存量 viewer 域恒值归属（agent_id
  // ='user' 的直落行）归一为无归属——落盘不动，读侧归一。
  let next: string | undefined;
  for (let i = merged.length - 1; i >= 0; i--) {
    const r = merged[i];
    if (r.role === 'assistant' && r.message_id) {
      next = r.message_id;
      continue;
    }
    if (r.role === 'context' && r.run === undefined && next !== undefined) r.anchor = next;
  }
  // 前向回落：尾部直落卡（其后无任何 agent 发言行）锚向前向最近 agent 行
  let prev: string | undefined;
  for (let i = 0; i < merged.length; i++) {
    const r = merged[i];
    if (r.role === 'assistant' && r.message_id) {
      prev = r.message_id;
      continue;
    }
    if (r.role === 'context' && r.run === undefined && r.anchor === undefined && prev !== undefined) r.anchor = prev;
  }
  return opts.view === 'lite' ? merged.map(liteRow) : merged;
}

// —— 投影三：LLM 回放（historyMessagesFor 语义——轨迹展开 + injected 判重） ——

/**
 * LLM 回放投影（viewer = 本壳 agent）：时间线 = speech ∪ 机制通知
 *（context+event 行）按 ts 归并；带 run 键的终稿行前置该 run 轨迹
 *（协议对，含末步与终稿同文让位）；注入 requestId 判重防双喂。
 * summary 头由调用方置首（summaryTextOf 取源）。
 */
export interface FoldLlmOptions {
  /** 活动 run 排除（cr-1101）：driveRun 传当前 runId——防轮间重派生把
   *  在途 run 自己的轨迹喂回自己（双喂）；续跑（resume）前缀与回放各管
   *  一半（回放管其他 run 的一切事实，resume 管本 run 前缀），无交集。 */
  excludeRun?: string;
  /** 声明查值（cr-1104 注册制）：source/injectSource 词 → 注册档；
   *  缺省（未注册/未传）= wrapper（非 speech 事实行默认档） */
  replayOf?: (word: string) => ReplayKind | undefined;
}

export function foldLlmReplay(
  fold: SessionFold,
  viewer: string,
  dataRoot: string,
  conversationId: string,
  subcallsOf?: (domain: string, run: string) => JournalToolResult[] | undefined,
  opts: FoldLlmOptions = {},
): LlmMessage[] {
  const out: LlmMessage[] = [];
  const traced = new Set<string>();
  // 压缩三态（§2.3）+ cr-1189 V3 摘要头单源：archive-summary 行在场
  // （未 shadow）时摘要即行——wrapper 档随下方时间线进回放，天然落新代
  // 头部，system 头不再另发（防与 v2 存量摘要双份）；无行才回落 v2
  // 事件摘要头；v1 无压缩 → 调用方概要兼容窗
  // cr-1274 摘要单源：V3 行正文以 context 行进时间线（wrapper 包裹），
  // digest 在场时不发 system 头防双计；v2 存量代头已随全量物化退役。
  void foldDigestOf;
  // cr-1104 注册制分档：声明词按注册档（original 原文/none 跳过），缺省 wrapper
  const kindOf = (word: string | undefined): ReplayKind =>
    (word !== undefined && REPLAY_BUILTIN_NONE.has(word)) ? 'none' : (word !== undefined ? opts.replayOf?.(word) : undefined) ?? 'wrapper';

  // 时间线（文件序 ≈ 时间序；稳定归并——speech 先于同刻 context）。
  // cr-1101：error 行进时间线（曾进入 run 的失败事实必须回放——user
  // 语义位 + wrapper 包裹）；孤儿 run（有步/注入事实、无 run-end、无终稿
  // 行锚——settle 前崩溃）轨迹按末事实 ts 插入时间线。有 run-end 无终稿
  // 行 = 机制 run（归档整理三不）仍排除；活动 run 由 excludeRun 排除。
  type Slot = { ts: string; ord: number; speech?: SpeechEvent; notice?: ContextEvent; orphan?: string; orphanSeq?: number };
  const timeline: Slot[] = [];
  let ord = 0;
  for (const s of fold.speech) timeline.push({ ts: s.timestamp, ord: ord++, speech: s });
  // cr-1106 全量准入:一切 context 行进时间线(词 → 回放档由声明分派:
  // none 跳过、original 裸文、缺省 wrapper)——拆掉「非 event 词天生 once」
  // 的结构坑。v1 存量 skill/memory/durable context 行随之恢复跨 run 回放
  // (原则 1:曾进入 run 的事实必须回放);数据根实证 context/inject 零双写。
  for (const c of fold.contexts) {
    if (c.content.trim() !== '') timeline.push({ ts: c.timestamp, ord: ord++, notice: c });
  }
  const anchored = new Set<string>();
  for (const s of fold.speech) {
    const r0 = s.run ?? s.sourceRun;
    if (r0 !== undefined && r0 !== '') anchored.add(r0);
  }
  for (const [run, rf] of fold.runs) {
    if (anchored.has(run) || run === opts.excludeRun || rf.end !== undefined) continue;
    const hasFacts = rf.events.some((ev) => ev.kind !== 'tool-call-result') || rf.aggregated !== undefined;
    if (!hasFacts) continue;
    let lastTs = 0;
    let lastSeq: number | undefined;
    for (const ev of rf.events) {
      if (ev.kind === 'tool-call-result') continue;
      if ((ev.ts ?? 0) > lastTs) lastTs = ev.ts ?? 0;
      if (ev.seq !== undefined && ev.seq > (lastSeq ?? 0)) lastSeq = ev.seq;
    }
    if (lastTs <= 0) continue; // 无 ts 事实（极端存量）——无锚不插
    timeline.push({ ts: new Date(lastTs).toISOString(), ord: ord++, orphan: run, ...(lastSeq !== undefined ? { orphanSeq: lastSeq } : {}) });
  }
  timeline.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.ord - b.ord));
  // 压缩边界过滤（cr-1160 P2：多轮叠加 + 三级裁决谓词 rowShadowedBy）。
  // 单维 seq → 双维 (seq, endTs)：位置维精确（v2 行恒带 seq），时刻维兜
  // 物理/事件后落账行（cr-1156 正式化）；v1 无 seq 行的第三级文件位置维
  // 由索引批消费（此处保守放行——与既有口径等价）。
  const tsNumOf = (s: Slot): number | undefined => {
    const ts = s.speech?.timestamp ?? s.notice?.timestamp;
    if (ts === undefined) return undefined;
    const n = Date.parse(ts);
    return Number.isFinite(n) ? n : undefined;
  };
  const bounded = fold.compactions.length > 0
    ? timeline.filter((s) => {
        const seq = s.speech?.seq ?? s.notice?.seq ?? s.orphanSeq;
        const tsNum = tsNumOf(s);
        return !fold.compactions.some((b) => rowShadowedBy(
          { ...(seq !== undefined ? { seq } : {}), ...(tsNum !== undefined ? { ts: tsNum } : {}) },
          b,
        ));
      })
    : timeline;
  const subcallsFor = (domain: string, run: string): JournalToolResult[] =>
    subcallsOf?.(domain, run) ?? foldSubcallArchive(fold, dataRoot, conversationId, domain);
  for (const slot of bounded) {
    if (slot.notice !== undefined) {
      // cr-888/1101/1106：context 行按 user 回放（事件通知/错误/注入材料
      // 全量准入）；cr-1104 分档：声明词按注册档（none = 不进回放），缺省 wrapper
      if (kindOf(slot.notice.source) === 'none') continue;
      out.push({ role: 'user', content: wrapForReplay(slot.notice.content, kindOf(slot.notice.source)) });
      continue;
    }
    if (slot.orphan !== undefined) {
      // cr-1101 孤儿 run 轨迹：无终稿行锚也回放（once 绝不允许）；无终稿
      // 行 = 无末步去重对象，全量直发
      const rf = fold.runs.get(slot.orphan);
      if (rf !== undefined) out.push(...trajectoryOfFacts(rf, slot.orphan, subcallsFor));
      continue;
    }
    const r = slot.speech!;
    const run = r.run ?? r.sourceRun;
    if (run !== undefined && run !== '' && !traced.has(run)) {
      traced.add(run);
      const rf = fold.runs.get(run);
      if (rf !== undefined) {
        const traj = trajectoryOfFacts(rf, run, subcallsFor, opts.replayOf);
        // 末步去重（v1 trajFromRows 消费点同款）：自然收束 run 的末步 content
        // 即终稿——轨迹末条无工具 assistant 与终稿行同文时让位给终稿行
        const last = traj.at(-1);
        if (r.content.trim() !== '' && last !== undefined && last.role === 'assistant'
          && !Array.isArray((last as { tool_calls?: unknown }).tool_calls) && last.content === r.content) {
          traj.pop();
        }
        out.push(...traj);
      }
    }
    if (r.content.trim() !== '') {
      // cr-1278：入站发言行的附件旁路随回放还原（仅 user 位——provider 物化
      // 只认 user 消息；assistant 行恒无附件）
      const toUser = r.agentId !== viewer;
      out.push({
        role: toUser ? 'user' : 'assistant',
        content: r.content,
        ...(toUser && r.attachments !== undefined ? { attachments: r.attachments } : {}),
      });
    }
  }
  return out;
}

/** 域 subcall 档案缓存（LLM 回放路径的回落全读） */
const subcallArchiveCache = new WeakMap<SessionFold, Map<string, JournalToolResult[]>>();
function foldSubcallArchive(fold: SessionFold, dataRoot: string, conversationId: string, domain: string): JournalToolResult[] {
  let cache = subcallArchiveCache.get(fold);
  if (cache === undefined) { cache = new Map(); subcallArchiveCache.set(fold, cache); }
  let list = cache.get(domain);
  if (list === undefined) {
    const facts = fold.factsOf.get(domain);
    list = facts?.subcallArchive ?? readSubcalls(sessionDir(dataRoot, domain, conversationId));
    cache.set(domain, list);
  }
  return list;
}

/**
 * run 轨迹 → 协议消息对（trajFromRows/trajectoryOfRun 的 fold 统一形态）：
 * 步/注入按事件行序归并——注入点前已见步全部冲刷；子调用平铺卡不进
 * 回放（宿主调用对即模型真实所见）；无结果调用已由 foldStepsOf 收束
 *（合成终态或 settled 合成空成功——与 v1 读侧同口径）。
 */
export function trajectoryOfFacts(
  rf: RunFactsV2 & { domain: string },
  run: string,
  subcallsFor: (domain: string, run: string) => JournalToolResult[],
  replayOf?: (word: string) => ReplayKind | undefined,
): LlmMessage[] {
  // cr-1104 注册制分档（trajectory 内 inject 同口径；缺省 wrapper）
  const kindOfT = (word: string | undefined): ReplayKind =>
    (word !== undefined && REPLAY_BUILTIN_NONE.has(word)) ? 'none' : (word !== undefined ? replayOf?.(word) : undefined) ?? 'wrapper';
  const steps0 = foldStepsOf(rf, subcallsFor(rf.domain, run))?.steps ?? [];
  // cr-1101 未收束 run（孤儿）读方配平：无结果调用合成「结果未知/未
  // 启动」终态（resumeStateFor / UNCOMMITTED_TOOL_ERROR 同语义）——回放
  // 不许出现盲 ok；已收束 run 的合成仍由 foldStepsOf 收口（不变）。
  const steps = rf.end === undefined
    ? steps0.map((s) => s.toolCalls === undefined ? s : {
        ...s,
        toolCalls: s.toolCalls.map((tc) => tc.result == null
          ? { ...tc, result: { ok: false, error: s.aborted === true ? 'TOOL_NOT_STARTED' : UNCOMMITTED_TOOL_ERROR } }
          : tc),
      })
    : steps0;
  const out: LlmMessage[] = [];
  // 事件行序 → 步/注入交错（步号按首见序对应 foldStepsOf 的 acc 序）
  const stepOrder: number[] = [];
  const seenStep = new Set<number>();
  const slots: Array<{ kind: 'step'; step: number } | { kind: 'inject'; content: string; injectSource?: string; attachments?: LedgerAttachment[] }> = [];
  for (const ev of rf.events) {
    if (ev.kind === 'inject') { slots.push({ kind: 'inject', content: ev.content, ...(ev.injectSource !== undefined ? { injectSource: ev.injectSource } : {}), ...(ev.attachments !== undefined ? { attachments: ev.attachments } : {}) }); continue; }
    if (ev.kind === 'tool-call-result') continue;
    if (!seenStep.has(ev.step)) { seenStep.add(ev.step); stepOrder.push(ev.step); slots.push({ kind: 'step', step: ev.step }); }
  }
  const byStep = new Map<number, ProjectedStep>();
  stepOrder.forEach((s, i) => byStep.set(s, steps[i]!));
  let covered = 0;
  for (const slot of slots) {
    if (slot.kind === 'inject') {
      if (kindOfT(slot.injectSource) === 'none') continue;
      out.push({
        role: 'user',
        content: wrapForReplay(slot.content, kindOfT(slot.injectSource)),
        ...(slot.attachments !== undefined ? { attachments: slot.attachments } : {}),
      });
      continue;
    }
    pushStep(out, byStep.get(slot.step));
    covered++;
  }
  // 聚合轨迹兜底（v1 settle 后 journal 已清——事件流无步插槽，steps 全量直发）
  for (; covered < steps.length; covered++) pushStep(out, steps[covered]);
  return out;
}

function pushStep(out: LlmMessage[], s: ProjectedStep | undefined): void {
  if (s === undefined) return;
  const calls = (s.toolCalls ?? []).filter((tc) => tc.subcall !== true && (tc.id || tc.name));
  if (calls.length === 0 && s.content.trim() === '') return;
  out.push({
    role: 'assistant',
    content: s.content,
    ...(calls.length > 0 ? { tool_calls: calls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })) } : {}),
  });
  for (const tc of calls) {
    out.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(tc.result ?? { ok: true }) });
  }
}
