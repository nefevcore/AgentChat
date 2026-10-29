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
import { readLedger, readJournal, stepsOfLedger, stepsOfRun } from './reader.ts';
import { sessionDir } from './writer.ts';
import { UserLedger } from './user.ts';
import type { JournalLine, LedgerRow, ProjectedStep } from './records.ts';

/** 活跃 run 聚集行（face-ops collectRunning 形状子集） */
export interface RunningEntry {
  agentId: string;
  conversationId: string;
  runId: string | null;
}

export interface SessionViewOptions {
  /** lite 视图：steps 超长字段截断为摘要（移动端瘦身） */
  view?: 'lite';
  /** 活壳 run 聚集（journal 活投影门控——runId 精确命中才投在途步） */
  running?: RunningEntry[];
}

/** 域面（journal + 账本行——每域只解析一次） */
interface Face { lines: JournalLine[]; rows: LedgerRow[]; }

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
 * 读面单次化（cr-768）：viewer 账本读一次、每 agent 域 journal/账本解析
 * 一次（对桶键 participants 双端并读按合并面缓存）——此前 web-api 三层
 * 循环各自重读，同文件最多解析四遍。
 */
export function assembleSessionView(
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
  const stepsFor = (agentId: string, run: string): { steps: ProjectedStep[]; partial: boolean } | null => {
    const { lines, rows } = faceFor(agentId);
    return stepsOfLedger(rows, run) ?? stepsOfRun(lines, run);
  };
  // viewer 终稿层（单次读，两个消费面共用）
  const replay = new UserLedger(dataRoot, conversationId, ['user']).replay();
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
      if (r.source !== 'inject' || r.run === undefined) continue;
      projectInject(r.run, {
        role: 'context',
        content: r.content,
        ...(r.label !== undefined ? { label: r.label } : {}),
        source: r.injectSource ?? 'inject',
        message_id: r.message_id,
        timestamp: r.timestamp,
        agent_id: r.agent_id,
        run: r.run,
        ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
      });
    }
    for (const l of lines) {
      if (l.type !== 'journal-inject' || l.run === '') continue;
      projectInject(l.run, {
        role: 'context',
        content: l.content,
        ...(l.label !== undefined ? { label: l.label } : {}),
        source: l.injectSource ?? 'inject',
        message_id: l.injectionId ?? 'jinj-' + l.run + '-' + (l.seq ?? 0),
        timestamp: new Date(l.ts ?? Date.now()).toISOString(),
        agent_id: domain,
        run: l.run,
        ...(l.requestId !== undefined ? { requestId: l.requestId } : {}),
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
      const p = stepsOfLedger(rows, run) ?? stepsOfRun(lines, run);
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
    for (const file of [path.join(dir, 'messages.jsonl'), path.join(dir, 'journal', 'partials.jsonl')]) {
      try {
        const st = fs.statSync(file);
        parts.push(file + ':' + st.size + ':' + st.mtimeMs);
      } catch { /* 缺席文件不参与 */ }
    }
  }
  return { domains, fingerprint: parts.sort().join('|') };
}
