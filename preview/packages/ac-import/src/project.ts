// ============================================================
// project.ts —— 行投影器（旧行 → 新账本行 + journal 重建）
//
// 投影面（R-10 恒等门「导入方向」）：
//   · actor 映射：user/assistant 旧 baked 词 → role:agent + agent_id 标注；
//     event/error 旧词 → context+source（M-role-v2 迁移后绝迹，双保险）；
//   · steps[]/reasoning_content → journal-step 行（工具卡全字段保留）；
//   · partial:true 死数据不入新账本（旧根保真，v6 迁移同判）；
//   · 未收束 run：部分行物化为中断收束段行（旧 recoverJournal 投影语义）；
//   · envelope 字段缺席补 null（additive 可空——R-10 恒等门语义）。
// ============================================================
import type { LegacyRow, LegacyRunSettled, LegacyJournalRow } from './legacy.ts';
import type { LedgerRow, LedgerHeader, JournalStep, JournalInject, JournalSettled } from 'ac-ledger';

/** 投影上下文（agentId = 归属 agent——pairKey 尾段或 singles 的 preset） */
export interface ProjectContext {
  agentId: string;
  /** 会话身份键（新 uuid = 旧 pairKey 保留原键） */
  uuid: string;
  /** pairKey 两端（header participants） */
  participants: string[];
  /** 会话形态（header kind：1v1 = agent-pair / single = user / 群转录流 = gid） */
  kind: string;
}

/** 投影产物 */
export interface Projected {
  header: LedgerHeader;
  rows: LedgerRow[];
  journal: Array<JournalStep | JournalInject | JournalSettled>;
  subcalls: LedgerRow[];
  /** 恒等拷贝面（旧目录未知文件——新目录原样拷贝） */
  extraFiles: string[];
  /** 恒等门对账（投递/丢弃/物化/子调用计数） */
  stats: { delivered: number; dropped: number; materialized: number; subcalls: number };
}
/** 单行 actor 投影（纯函数）：旧 role 词 → 新 actor 词汇 */
function actorOf(r: LegacyRow, ctx: ProjectContext): { role: 'agent' | 'context'; agent_id: string; source?: string } {
  // baked 旧词（无 session-header 文件的宽容读取路径）：user → 端点 user；assistant → 归属 agent
  if (r.role === 'user') return { role: 'agent', agent_id: 'user' };
  if (r.role === 'assistant') return { role: 'agent', agent_id: r.agent_id ?? ctx.agentId };
  if (r.role === 'event' || r.role === 'error') {
    return { role: 'context', agent_id: r.agent_id ?? ctx.agentId, source: r.source ?? r.role };
  }
  if (r.role === 'agent' || r.role === 'context') {
    return r.role === 'agent'
      ? { role: 'agent', agent_id: r.agent_id ?? ctx.agentId }
      : { role: 'context', agent_id: r.agent_id ?? ctx.agentId, source: r.source };
  }
  // system/tool 预留词及其余：按 context 对待（source 原样）
  return { role: 'context', agent_id: r.agent_id ?? ctx.agentId, source: r.source ?? r.role };
}

/** 坏行/残留 run-settled 之外的全部旧行 → 新 rows + journal（顺序恒等） */
export function projectSession(
  rows: Array<LegacyRow | LegacyRunSettled>,
  partials: LegacyJournalRow[],
  ctx: ProjectContext,
  extraFiles: string[],
  headerCreatedAt: string | null = null,
): Projected {
  const out: Projected = {
    header: {
      type: 'session-header',
      version: 1,
      createdAt: headerCreatedAt ?? (rows.length > 0 && 'timestamp' in rows[0] ? (rows[0] as LegacyRow).timestamp : new Date().toISOString()),
      participants: ctx.participants,
      kind: ctx.kind,
      // @ts-expect-error migrated 标记（R-10：会话 header 标 migrated: true——行协议不加标记字段）
      migrated: true,
    },
    rows: [],
    journal: [],
    subcalls: [],
    extraFiles,
    stats: { delivered: 0, dropped: 0, materialized: 0, subcalls: 0 },
  };
  // 已收束 run 集（messages 内 run-settled 行 + 非 partial 段行的 run 键）
  const settledRuns = new Set<string>();
  for (const r of rows) {
    if (r.type === 'run-settled' && typeof r.run === 'string') settledRuns.add(r.run);
    else if (typeof r.run === 'string' && r.run && r.partial !== true) settledRuns.add(r.run);
  }
  // per-run 步序计数器（跨段行延续）+ 已落 journal-settled 的 run 集（尾部统一补落，防切段中间重复）
  const stepCounters = new Map<string, number>();
  const settledStepRuns = new Set<string>();
  for (const r of rows) {
    // run-settled 判别行 → journal-settled（新侧收束标记物化进 journal）
    if (r.type === 'run-settled' && typeof r.run === 'string') {
      out.journal.push({ type: 'journal-settled', run: r.run, finish: 'ok' });
      continue;
    }
    const lr = r as LegacyRow;
    // partial 死数据不入新账本（v6 迁移同判——旧根保真）
    if (lr.partial === true) { out.stats.dropped++; continue; }
    const actor = actorOf(lr, ctx);
    // 未知字段透传（恒等门全字段校验面）
    const row: LedgerRow = {
      role: actor.role,
      content: lr.content,
      message_id: lr.message_id,
      timestamp: lr.timestamp,
      agent_id: actor.agent_id,
      // envelope 字段缺席即无（additive 可空——缺席优于 null，行内零噪声）
      ...(lr.requestId !== undefined ? { requestId: lr.requestId } : {}),
      uuid: ctx.uuid,
      ...(actor.source !== undefined ? { source: actor.source } : {}),
      ...(lr.run !== undefined ? { run: lr.run } : {}),
      // steps/reasoning 投影进 journal（终稿行不携带——新侧 journal 独占）
    };
    out.rows.push(row);
    out.stats.delivered++;
    // steps[]/reasoning_content → journal-step 重建（工具卡全字段保留）。
    // 步序 per-run 全局延续：settlement 切段后同 run 多条段行的 steps[] 各自
    // 局部编号，journal 语义（行序 = 模型消息数组实际序）要求跨段延续计数。
    if (lr.steps !== undefined && lr.steps.length > 0) {
      const run = lr.run ?? ('migrated-' + lr.message_id);
      lr.steps.forEach((s) => {
        const n = (stepCounters.get(run) ?? 0) + 1;
        stepCounters.set(run, n);
        const step: JournalStep = {
          type: 'journal-step',
          run,
          step: n,
          content: s.content ?? '',
          ...(s.reasoning !== undefined ? { reasoning: s.reasoning } : {}),
          ...(s.toolCalls !== undefined && s.toolCalls.length > 0 ? { toolCalls: s.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })) } : {}),
        };
        out.journal.push(step);
      });
      settledStepRuns.add(run);
    }
    if (lr.reasoning_content !== undefined && lr.reasoning_content !== '' && (lr.steps === undefined || lr.steps.length === 0)) {
      // 孤立 reasoning（无 steps）：作单步 journal 保留思维链
      const run = lr.run ?? ('migrated-' + lr.message_id);
      out.journal.push({ type: 'journal-step', run, step: 1, content: '', reasoning: lr.reasoning_content });
      settledStepRuns.add(run);
    }
  }
  // steps 重建的 run 统一落 settled（同 run 多段行只落一次；行序在全部 step 之后）
  for (const run of settledStepRuns) {
    out.journal.push({ type: 'journal-settled', run, finish: 'ok' });
  }
  // partials.jsonl 重建：新 journal 内已含 settled 行——旧 partials 内已收束 run 的行是双保险冗余，跳过；
  // 未收束 run 的步行 → 物化为中断收束段行（旧 recoverJournal 投影语义）
  for (const p of partials) {
    if (typeof p.run !== 'string' || !p.run) continue;
    if (settledRuns.has(p.run)) continue;
    if (p.type === 'journal-step' || p.type === 'journal-inject' || (p as { partial?: unknown }).partial === true) {
      // 新形态步行（未收束）：随迁 journal；partial 旧行丢弃（v6 同判）
      if (p.type === 'journal-step' || p.type === 'journal-inject') out.journal.push(p as unknown as JournalStep | JournalInject);
      continue;
    }
    // 旧形态无 type 行（未收束 run）：content 物化为中断段行
    const content = typeof p.content === 'string' ? p.content : '';
    if (content === '') continue;
    out.rows.push({
      role: 'agent',
      content,
      message_id: typeof p.message_id === 'string' ? p.message_id : 'mig-' + ctx.uuid + '-' + out.rows.length,
      timestamp: typeof p.timestamp === 'string' ? p.timestamp : new Date().toISOString(),
      agent_id: ctx.agentId,
      uuid: ctx.uuid,
      run: p.run,
    });
    out.stats.materialized++;
  }
  return out;
}

/** subcalls 投影：子调用档案行 → context+source:subcall（恒等拷贝面外唯一改写） */
export function projectSubcalls(subcalls: LegacyRow[], ctx: ProjectContext): LedgerRow[] {
  return subcalls.map((r) => ({
    role: 'context',
    content: r.content,
    message_id: r.message_id,
    timestamp: r.timestamp,
    agent_id: r.agent_id ?? ctx.agentId,
    uuid: ctx.uuid,
    source: 'subcall',
    ...(r.run !== undefined ? { run: r.run } : {}),
  }));
}
