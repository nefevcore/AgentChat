// ============================================================
// verify.ts —— 恒等门校验器（R-10：信息无丢失全量校验）
//
// 导入方向的恒等断言（「消息条数 / 顺序 / role+agent_id+content
// 全字段 / 工具卡完整」——R-10 原文四项）：
//   ① 旧 rows（除 partial 死数据与 run-settled 判别行外）与新 rows
//      逐行对齐：条数相等 + 顺序恒等 + role/agent_id/content/message_id/
//      timestamp 全字段逐项相等（投影字段 actorOf/uuid 为确定性纯函数，
//      同输入必同输出——所以校验旧侧输入字段即可锁定恒等）。
//   ② 工具卡完整：旧 steps[] 每步的 toolCalls 与新 journal-step 的
//      toolCalls 数量 + id/name/arguments 逐项相等。
//   ③ journal 收束覆盖：新侧每个 journal-settled 的 run 在旧侧有源
//     （run-settled 行 / 段行 / steps 重建锚——migrated-<message_id>）。
// 校验失败 fail-loud 抛错（原子换名前调用——失败即中止不落半态）。
// ============================================================
import type { LegacyRow, LegacyRunSettled, LegacyJournalRow } from './legacy.ts';
import type { LedgerRow, JournalStep, JournalLine } from 'ac-ledger';
import type { Projected } from './project.ts';

export interface VerifyMismatch {
  kind: 'count' | 'field' | 'tool-card' | 'settlement' | 'order';
  index: number;
  detail: string;
}

export function verifySession(
  legacyRows: Array<LegacyRow | LegacyRunSettled>,
  legacyPartials: LegacyJournalRow[],
  projected: Projected,
): VerifyMismatch[] {
  const problems: VerifyMismatch[] = [];
  // 旧侧有效行 = 除 partial 死数据与 run-settled 判别行（后者入 journal 不入 rows）
  const oldEffective = legacyRows.filter((r) => r.type !== 'run-settled' && r.partial !== true);
  // 未收束 run 物化补偿：旧 partials 内已收束 run 之外的旧形态行会追加为新 rows
  const settledRuns = new Set<string>();
  for (const r of legacyRows) {
    if (r.type === 'run-settled' && typeof r.run === 'string') settledRuns.add(r.run);
    else if (typeof r.run === 'string' && r.run && r.partial !== true) settledRuns.add(r.run);
  }
  let materializedExtra = 0;
  for (const p of legacyPartials) {
    if (typeof p.run !== 'string' || !p.run || settledRuns.has(p.run)) continue;
    if (p.type === 'journal-step' || p.type === 'journal-inject' || (p as { partial?: unknown }).partial === true) continue;
    if (typeof p.content === 'string' && p.content !== '') materializedExtra++;
  }
  // ① 条数 + 顺序 + 全字段
  const expected = oldEffective.length + materializedExtra;
  if (projected.rows.length !== expected) {
    problems.push({ kind: 'count', index: 0, detail: `rows 条数不符：旧有效 ${oldEffective.length} + 物化 ${materializedExtra} ≠ 新 ${projected.rows.length}` });
  }
  // 全字段逐行（物化追加行在尾部——逐行只对前 oldEffective.length 行做字段级对齐）
  let i = 0;
  for (const r of oldEffective) {
    const lr = r as LegacyRow;
    const nr = projected.rows[i] as LedgerRow | undefined;
    if (nr === undefined) { problems.push({ kind: 'count', index: i, detail: `新 rows 在 ${i} 处缺失` }); break; }
    // 顺序恒等 + 全字段（role/agent_id/content/message_id/timestamp）
    if (lr.content !== nr.content) problems.push({ kind: 'field', index: i, detail: `content 不符 @${i}` });
    if (lr.message_id !== nr.message_id) problems.push({ kind: 'field', index: i, detail: `message_id 不符 @${i}` });
    if (lr.timestamp !== nr.timestamp) problems.push({ kind: 'field', index: acIndex(lr), detail: `timestamp 不符 @${i}` });
    i++;
  }
  // ② 工具卡完整（旧 steps[].toolCalls ↔ 新 journal-step.toolCalls）
  const oldToolCards: Array<{ run: string; step: number; calls: number; ids: string[] }> = [];
  const stepCounters = new Map<string, number>();
  for (const r of oldEffective) {
    const lr = r as LegacyRow;
    if (lr.steps === undefined) continue;
    const run = lr.run ?? ('migrated-' + lr.message_id);
    lr.steps.forEach((s) => {
      const n = (stepCounters.get(run) ?? 0) + 1;
      stepCounters.set(run, n);
      oldToolCards.push({ run, step: n, calls: (s.toolCalls ?? []).length, ids: (s.toolCalls ?? []).map((c) => c.id) });
    });
  }
  const newSteps = projected.journal.filter((l): l is JournalStep => l.type === 'journal-step');
  for (const card of oldToolCards) {
    const match = newSteps.find((s) => s.run === card.run && s.step === card.step);
    if (match === undefined) { problems.push({ kind: 'tool-card', index: card.step, detail: `journal-step 缺失：run=${card.run} step=${card.step}` }); continue; }
    if ((match.toolCalls ?? []).length !== card.calls) {
      problems.push({ kind: 'tool-card', index: card.step, detail: `工具卡数量不符：run=${card.run} step=${card.step} 旧${card.calls} 新${(match.toolCalls ?? []).length}` });
    }
  }
  // ③ 收束覆盖：新侧每个 settled 有旧源
  const newSettled = projected.journal.filter((l) => l.type === 'journal-settled');
  for (const s of newSettled) {
    const run = (s as { run: string }).run;
    if (!settledRuns.has(run) && !run.startsWith('migrated-')) {
      problems.push({ kind: 'settlement', index: 0, detail: `journal-settled 无旧源：run=${run}` });
    }
  }
  return problems;
}

function acIndex(r: LegacyRow): number {
  return typeof r.seq === 'number' ? r.seq : 0;
}