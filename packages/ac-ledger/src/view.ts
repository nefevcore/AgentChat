// ============================================================
// view.ts —— 会话读面视图组装（cr-768 读面优化回填）
//
// 三个职责，归位数据拥有者 ac-ledger（web-api 传输层只透传参数——
// cr-95 D2「投影归位」同款裁决的 cutover 后重现）：
//   · assembleSessionView：viewer 终稿层 + 全域 journal/账本单次读组装
//     （steps 联查 / 注入行归口 / 活投影 / 盲区投影——每文件只解析一次）；
//   · lite 视图（原 cr-54/55，cutover 迁移遗漏回填）：steps 超长字段截断
//     为摘要——移动端带宽瘦身（重会话 98.7% 体积在 run_code 轨迹）；
//     缓存纪律 = 逐层浅拷贝、零变异（cr-55 病理防复发）；
//   · historyView：跨域 stat 复合指纹（fingerprint 短路判据，原
//     2026-09-19 切换重入优化回填）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { conversationDirs } from './manage.ts';
import { readLedger, readJournal, readSubcalls, stepsOfLedger, stepsOfRun } from './reader.ts';
import { sessionDir } from './writer.ts';
import { projectUserReplay } from './project.ts';
import { foldSession, foldViewRecords } from './fold.ts';
import type { JournalLine, JournalToolResult, LedgerRow, ProjectedStep } from './records.ts';

/** 活跃 run 聚集行（face-ops collectRunning 形状子集） */
export interface RunningEntry {
  agentId: string;
  conversationId: string;
  runId: string | null;
}

export interface SessionViewOptions {
  /** 视图参数化（cr-973，纯函数零存储差异）：lite = steps 超长字段截断
   *  摘要（移动端瘦身）；plain = DSH 式无气泡视图——无气泡是前端渲染
   *  参数，记录面与 chat 同构（服务端等值透传，不另立投影）。 */
  view?: 'chat' | 'plain' | 'lite';
  /** 活壳 run 聚集（journal 活投影门控——runId 精确命中才投在途步） */
  running?: RunningEntry[];
  /** subcall 档案定向读钩子（cr-973 索引辅助）：给该域该 run 的
   *  subcalls.jsonl 行（seek 定位）；undefined = 该域档案未索引 → 调用方
   *  回落全文件读。返回数组（可空）= 已索引，直接采用。 */
  subcallsOf?: (domain: string, run: string) => JournalToolResult[] | undefined;
}

/** 域面（journal + 账本行 + 子调用档案——每域只解析一次） */
interface Face { lines: JournalLine[]; rows: LedgerRow[]; subcalls?: JournalToolResult[]; }

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

/** lite 行投影：无 steps 的行对象身份直通（零拷贝纪律）；有 steps 的浅拷贝投影 */
function liteRow(r: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(r.steps)) return r;
  return { ...r, steps: (r.steps as ProjectedStep[]).map(liteProjectStep) };
}

/**
 * 会话读面视图组装（session/history 的投影体）。
 * cr-974（cr-972 第二刀）起 = fold 单源的 webui 投影（fold.ts——读方配平
 * 与 v1/v2 归一化同源）；下文 assembleSessionViewLegacy 为切换前实现，
 * 仅供 parity 对拍保留一个版本（Phase 2 收尾随 v1 读兼容窗退役）。
 */
export function assembleSessionView(
  dataRoot: string,
  conversationId: string,
  opts: SessionViewOptions = {},
): Array<Record<string, unknown>> {
  return foldViewRecords(foldSession(dataRoot, conversationId), dataRoot, conversationId, {
    ...(opts.view !== undefined ? { view: opts.view } : {}),
    ...(opts.running !== undefined ? { running: opts.running } : {}),
    ...(opts.subcallsOf !== undefined ? { subcallsOf: opts.subcallsOf } : {}),
  });
}

/**
 * 会话读面视图组装（cr-768 读面单次化形态——cr-974 前实现，parity 对拍保留）。
 */
export function assembleSessionViewLegacy(
  dataRoot: string,
  conversationId: string,
  opts: SessionViewOptions = {},
): Array<Record<string, unknown>> {
  // ── 域面单次读（含 journal-only 域——崩溃孤儿 run 只有 journal 步行）──
  const dirs = conversationDirs(dataRoot, conversationId, { includeJournalOnly: true });
  const faceMap = new Map<string, Face>();
  const ensureFace = (domain: string, dir?: string): Face => {
    let f = faceMap.get(domain);
    if (f === undefined) {
      const base = dir ?? sessionDir(dataRoot, domain, conversationId);
      f = { lines: readJournal(base), rows: readLedger(base).rows };
      faceMap.set(domain, f);
    }
    return f;
  };
  for (const dir of dirs) {
    const domain = path.basename(path.dirname(path.dirname(dir)));
    if (domain === 'viewer') continue;
    ensureFace(domain, dir);
  }
  // 合并面缓存：对桶键（a~b）双端并读（cr-611——迁移直答 pair 的 journal
  // 住尾段域、运行时 pair 住对端域，按 participants 取并集，run 键不相交无重）
  const mergedOf = new Map<string, Face>();
  const faceFor = (agentId: string): Face => {
    let m = mergedOf.get(agentId);
    if (m !== undefined) return m;
    const own = ensureFace(agentId);
    if (!conversationId.includes('~')) {
      m = own;
    } else {
      const lines = [...own.lines];
      const rows = [...own.rows];
      for (const part of conversationId.split('~')) {
        if (part === agentId) continue;
        const pf = ensureFace(part);
        lines.push(...pf.lines);
        rows.push(...pf.rows);
      }
      m = { lines, rows };
    }
    mergedOf.set(agentId, m);
    return m;
  };
  // subcall 档案取值：索引钩子优先（cr-973——按 run 定位 seek，重度会话
  // 不再全文件解析）；未索引回落惰性全读（首用触发，此后面内缓存）
  const subcallsFor = (domain: string, run: string): JournalToolResult[] => {
    const viaIndex = opts.subcallsOf?.(domain, run);
    if (viaIndex !== undefined) return viaIndex;
    const f = ensureFace(domain);
    f.subcalls ??= readSubcalls(sessionDir(dataRoot, domain, conversationId));
    return f.subcalls;
  };
  const stepsFor = (agentId: string, run: string): { steps: ProjectedStep[]; partial: boolean } | null => {
    const { lines, rows } = faceFor(agentId);
    return stepsOfLedger(rows, run, subcallsFor(agentId, run)) ?? stepsOfRun(lines, run);
  };
  // user 终稿层（cr-973 读时投影——agent 域账本纯函数，viewer 不再物化）
  const replay = projectUserReplay(dataRoot, conversationId);
  // 注入行投影（cr-707）：按 run 键归口，插在该 run 终稿行/盲区步行之前。
  // cr-739：busy-steer 注入行与 viewer 同 requestId user 行并生时注入卡不投
  //（用户卡片承载该消息——与直播形态一致）；机制注入照投。
  const injectRowsOf = new Map<string, Array<Record<string, unknown>>>();
  const seenInjectAnchors = new Set<string>();
  const viewerOwnRequestIds = new Set<string>();
  for (const r of replay) {
    if (r.role === 'user' && r.requestId !== undefined) viewerOwnRequestIds.add(r.requestId);
  }
  const projectInject = (run: string, row: Record<string, unknown>): void => {
    const anchor = String(row.message_id);
    if (seenInjectAnchors.has(anchor)) return;
    seenInjectAnchors.add(anchor);
    const req = row.requestId;
    if (typeof req === 'string' && req !== '' && viewerOwnRequestIds.has(req)) return;
    const bucket = injectRowsOf.get(run) ?? [];
    bucket.push(row);
    injectRowsOf.set(run, bucket);
  };
  for (const dir of dirs) {
    const domain = path.basename(path.dirname(path.dirname(dir)));
    if (domain === 'viewer') continue;
    const { lines, rows } = ensureFace(domain, dir);
    for (const r of rows) {
      // cr-888：会话设置变化通知行（context+event，run 锚定）与 inject 行
      // 同投注入卡（label 卡片；source 取 injectSource）
      // cr-959：context 直落行（memory-snapshot/memory-delta/skill 等——
      // source 非 event/error 机制词）同样卡片化：这些行真实进入 LLM 回放
      //（historyMessagesFor 直落分支 / settlement 提升），读面缺席 = 刷新后
      // 注入在前端不可见。判据与前端 isInjectEvent（source.kind 非机制词）
      // 单源对齐。
      const isInjectCard = r.source === 'inject'
        || (r.role === 'context' && r.source !== 'error');
      if (!isInjectCard || r.run === undefined) continue;
      projectInject(r.run, {
        role: 'context',
        content: r.content,
        ...(r.label !== undefined ? { label: r.label } : r.source !== 'inject' && r.source !== 'event' ? { label: r.source } : {}),
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
        source: r.injectSource ?? (r.role === 'context' && r.source !== 'event' && r.source !== 'inject' ? r.source : 'inject'),
        message_id: r.message_id,
        timestamp: r.timestamp,
        agent_id: r.agent_id,
        run: r.run,
        ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
        ...(r.seq !== undefined ? { seq: r.seq } : {}), // B1 行级 seq 透传
      });
    }
    for (const l of lines) {
      if (l.type !== 'journal-inject' || l.run === '') continue;
      projectInject(l.run, {
        role: 'context',
        content: l.content,
        ...(l.label !== undefined ? { label: l.label } : {}),
        ...(l.payload !== undefined ? { payload: l.payload } : {}),
        source: l.injectSource ?? 'inject',
        message_id: l.injectionId ?? 'jinj-' + l.run + '-' + (l.seq ?? 0),
        timestamp: new Date(l.ts ?? Date.now()).toISOString(),
        agent_id: domain,
        run: l.run,
        ...(l.requestId !== undefined ? { requestId: l.requestId } : {}),
        ...(l.seq !== undefined ? { seq: l.seq } : {}), // B1 行级 seq 透传
      });
    }
  }
  // viewer 终稿层主投影：peer 行按 run 键联查 steps（物化段行优先，journal
  // 兜底存量与 in-flight）。行时间戳透传（cr-716——前端排序事实键）。
  const all: Array<Record<string, unknown>> = [];
  const viewerRuns = new Set<string>();
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
      ...(r.run !== undefined ? { run: r.run } : {}),
      // run 墙钟耗时透传（cr-772）——历史链栏「用时」段持久锚
      ...(r.runMs !== undefined ? { runMs: r.runMs } : {}),
      // B1 行级 seq 透传（viewer 终稿层行）
      ...(r.seq !== undefined ? { seq: r.seq } : {}),
      ...(projected !== null ? { steps: projected.steps, ...(projected.partial ? { partial: true } : {}) } : {}),
    });
  }
  // journal 活投影（cr-598）：running 集命中当前 run（runId 精确门控）按步
  // 追加 partial 行——run 中刷新回放已完成步并接续流式；崩溃孤儿 journal
  //（未收束但非当前 run）不投，不制造永恒在途行。
  const runningHere = (opts.running ?? [])
    .flatMap((r) => r.conversationId === conversationId && r.runId !== null ? [{ agentId: r.agentId, runId: r.runId }] : []);
  for (const run0 of runningHere) {
    const p = stepsOfRun(faceFor(run0.agentId).lines, run0.runId);
    if (p === null || !p.partial) continue;
    all.push(...(injectRowsOf.get(run0.runId) ?? []));
    for (const s of p.steps) {
      all.push({ role: 'assistant', agent_id: run0.agentId, content: '', run: run0.runId, steps: [s], partial: true });
    }
  }
  // steps 盲区投影（cr-628/698）：viewer 无对应行但有 steps 事实的 run 一律
  // 投出——空终稿 run（中断/崩溃）+ 壳死于终稿回信前的 settled run。
  // 候选与投影都用本域自身事实（非合并面——盲区 run 的归属域明确）。
  const runningIds = new Set(runningHere.map((r) => r.runId));
  for (const [domain, { lines, rows }] of faceMap) {
    const candidates = new Set<string>();
    for (const l of lines) {
      if (l.run !== '' && (l.type === 'journal-step' || l.type === 'journal-inject')) candidates.add(l.run);
    }
    for (const r of rows) {
      if (r.source === 'segment' && r.run !== undefined) candidates.add(r.run);
    }
    for (const run of candidates) {
      if (viewerRuns.has(run) || runningIds.has(run)) continue;
      const p = stepsOfLedger(rows, run, subcallsFor(domain, run)) ?? stepsOfRun(lines, run);
      if (p === null) continue;
      all.push(...(injectRowsOf.get(run) ?? []));
      all.push({
        role: 'assistant',
        agent_id: domain,
        content: '',
        run,
        steps: p.steps,
        ...(p.partial ? { partial: true } : {}),
      });
    }
    // cr-807：error 收束错误行透传（context+source:error——session-design
    // §2.5 落盘形态）。该 run 终稿行已由 viewer 终稿层/盲区投影投出，错误行
    // 从 agent 域行面直读紧随其后——刷新后前端红条可见（此前错误文案只活
    // 瞬态帧）。
    for (const r of rows) {
      if (r.role !== 'context' || r.source !== 'error') continue;
      all.push({
        role: 'error',
        agent_id: domain,
        content: r.content,
        message_id: r.message_id,
        timestamp: r.timestamp,
        run: r.run,
        ...(r.seq !== undefined ? { seq: r.seq } : {}), // B1 行级 seq 透传
      });
    }
    // cr-959：无 run 锚的 context 直落行（memory-snapshot/memory-delta——
    // before-start seam 直落，本 run 派生即含）真实进入 LLM 上下文，读面
    // 直投为 context 行（前端注入卡；source 原样透传）。与机制通知行
    //（context+event）分流：event 走分隔符，注入源走卡片。
    for (const r of rows) {
      if (r.role !== 'context' || r.source === undefined) continue;
      if (r.source === 'event' || r.source === 'error') continue;
      if (r.run !== undefined) continue; // run 锚定行已由 projectInject 归口
      all.push({
        role: 'context',
        content: r.content,
        // label 缺席回落 source 词（旧版直落行无 label——前端收起行不拿整段正文当文案）
        label: r.label ?? r.source,
        source: r.source,
        message_id: r.message_id,
        timestamp: r.timestamp,
        agent_id: domain,
        ...(r.seq !== undefined ? { seq: r.seq } : {}), // B1 行级 seq 透传
      });
    }
    // 机制通知行（cr-946）：壳自身合成的催办信（payload.mechanism——如重启
    // 后的「已重启」续跑通知）按机制行落账（context+event、无 run 锚），投为
    // **事件分隔符**——前端 buildTurns 对 event 行 flush，两段 run 才是两轮、
    // 各有自己的终稿气泡（此前这条边界在 viewer 投影里恒缺席：相邻 run 被并成
    // 一轮，前一段终稿降级为链内中间步而整段消失）。位置由前端稳定时间排序按
    // timestamp 还原，push 位次不敏感。
    for (const r of rows) {
      const mechanism = r.role === 'context' && r.source === 'event' && r.run === undefined;
      // 存量兼容（cr-946 前）：同一通知曾按入站发言行落账（agent_id='user'、
      // requestId 前缀 restarted-*）——读面按机制行投影。账本 append-only，
      // 不改写历史行。
      const legacy = r.role === 'agent' && r.agent_id === 'user'
        && typeof r.requestId === 'string' && r.requestId.startsWith('restarted-');
      if (!mechanism && !legacy) continue;
      all.push({
        role: 'event',
        agent_id: domain,
        // 只投正文（不带 label）：带 label 会被前端判成注入卡（不 flush 轮），
        // 边界语义丢失。
        content: r.content,
        message_id: r.message_id,
        timestamp: r.timestamp,
        source: 'event',
        ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
        ...(r.seq !== undefined ? { seq: r.seq } : {}),
      });
    }
  }
  return opts.view === 'lite' ? all.map(liteRow) : all;
}

/**
 * 会话视图指纹（fingerprint 短路判据；原 2026-09-19 优化回填，cr-768）：
 * viewer + 全部 agent 域账本/journal 文件的 size:mtimeMs 复合串（域序排序
 * 归一——跨平台 readdir 顺序不定）。append-only 下文件未变 = 读面输入未变；
 * 任何变化（新行/收束/compact 重写/journal 剔除）必变 mtime 或 size。
 */
export interface HistoryViewMeta {
  /** agent 域 id 集（viewer 派生源——不含 'viewer'） */
  domains: string[];
  fingerprint: string;
}

export function historyView(dataRoot: string, conversationId: string): HistoryViewMeta {
  const domains: string[] = [];
  const parts: string[] = [];
  // viewer 域文件也进指纹（replay 的输入——终稿层变化必须使短路失效）；
  // domains（派生源参数）只含 agent 域。
  for (const dir of conversationDirs(dataRoot, conversationId, { includeJournalOnly: true })) {
    const domain = path.basename(path.dirname(path.dirname(dir)));
    if (domain !== 'viewer') domains.push(domain);
    for (const file of [path.join(dir, 'messages.jsonl'), path.join(dir, 'journal', 'partials.jsonl'), path.join(dir, 'subcalls.jsonl')]) {
      try {
        const st = fs.statSync(file);
        parts.push(file + ':' + st.size + ':' + st.mtimeMs);
      } catch { /* 缺席文件不参与 */ }
    }
  }
  return { domains, fingerprint: parts.sort().join('|') };
}
