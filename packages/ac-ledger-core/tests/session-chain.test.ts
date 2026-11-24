// ============================================================
// session-chain.test.ts —— M-A cr-1270 v1→v2 迁移边（cr-1307 判据升级）：
//   ① 链四断言（注册即过——严格相邻/from 无重复/链完整/未来拒绝）；
//   ② facts 往返恒等：domainFactsOf(v1 三源) → 迁移边（段行直产相位行）→
//      v2 行 → domainFactsOf(v2 行) 两次 facts 语义相等（库面
//      sessionFactsEqual 单源——seq 豁免 / 空数组归一 / aggregated 投影
//      恒等 / 步面互斥）；
//   ③ 点名夹具：纯 v1 / 过渡态（v1 头 v2 行）/ 坏行 / subcalls 档案 /
//      语义收窄点（段行相位序 → 行序 → textBeforeTools 推导）；
//   ④ injectionId 回填（cr-707 前行迁移后恒有锚）；
//   ⑤ 混合文件升头（新头继承旧头全字段 + version:2 + migratedFrom:1）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  SESSION_CHAIN, migrateSessionForm, splitHeader, v2Header, sessionFactsEqual,
  type SessionForm,
} from '../src/session-chain.ts';
import { domainFactsOf, type DomainFacts } from '../src/index.ts';
import type { LedgerRow, JournalLine, JournalToolResult } from '../src/records.ts';

// validateChainFrom 是 ac-migration-core 的导出——经依赖包导入
import { validateChain, planChain as plan, chainCurrent as cur } from 'ac-migration-core';

const ISO = (ms: number): string => new Date(ms).toISOString();

/** v1 三源 → 归一化 facts → SessionForm */
function formOf(header: Record<string, unknown>, rows: LedgerRow[], journal: JournalLine[] = [], subcalls: JournalToolResult[] = []): SessionForm {
  return {
    header: splitHeader(header),
    facts: domainFactsOf('agent-a', 1, rows, journal, subcalls),
    v2Rows: [],
    subcallArchive: subcalls,
    badLines: [],
  };
}

/** v2 行 → 再归一化 facts */
function factsOfV2Rows(rows: Array<Record<string, unknown>>): DomainFacts {
  return domainFactsOf('agent-a', 2, rows as unknown as LedgerRow[], [], []);
}

/** facts 相等判据（cr-1307 起委托库面 sessionFactsEqual——判据单源；
 *  seq 全面豁免/空数组归一/aggregated 投影恒等已由库面承载） */
function expectFactsEqual(a: DomainFacts, b: DomainFacts): void {
  const r = sessionFactsEqual(a, b);
  if (!r.ok) throw new Error('facts 不等（库面判据）：' + r.diff);
}

// —— 夹具：典型纯 v1 会话（user 入站 + 两步 run + 收束 + 段行 + 注入）——
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const RUN = 'run-send-1';
function pureV1(): { header: Record<string, unknown>; rows: LedgerRow[]; journal: JournalLine[]; subcalls: JournalToolResult[] } {
  const rows: LedgerRow[] = [
    { role: 'agent', content: '问个问题', message_id: 'm-1', timestamp: ISO(T0), agent_id: 'user', requestId: 'send-1', seq: 1 },
    { role: 'agent', content: '终稿答案', message_id: 'm-2', timestamp: ISO(T0 + 30_000), agent_id: 'agent-a', requestId: 'send-1', run: RUN, runMs: 30_000, seq: 5 },
  ];
  const journal: JournalLine[] = [
    { type: 'journal-step', run: RUN, step: 0, content: '', reasoning: '先想想', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], ts: T0 + 1000, seq: 2 },
    { type: 'journal-inject', run: RUN, content: '<sys>提醒</sys>', injectSource: 'skill', label: '已加载技能 demo', ts: T0 + 1500, seq: 3 },
    { type: 'journal-tool-result', run: RUN, toolCallId: 'c1', result: { ok: true, output: 'file-body' }, durationMs: 120, ts: T0 + 2000, seq: 4 },
    { type: 'journal-settled', run: RUN, finish: 'ok', usage: { prompt: 100, completion: 20, total: 120 }, model: 'test-model', ts: T0 + 29_000, seq: 6 } as unknown as JournalLine,
  ];
  return {
    header: { type: 'session-header', version: 1, createdAt: ISO(T0), participants: ['user', 'agent-a'], kind: 'user' },
    rows,
    journal,
    subcalls: [],
  };
}

describe('M-A 链四断言（注册即过）', () => {
  it('严格相邻 / from 无重复 / 链完整（v1..2 全环）', () => {
    expect(validateChain(SESSION_CHAIN)).toEqual([]);
    expect(cur(SESSION_CHAIN)).toBe(2);
  });
  it('未来拒绝：stored v3 > current v2 → 显式抛错', () => {
    expect(() => plan(SESSION_CHAIN, 3)).toThrow(/未来版本/);
  });
  it('v1 起链：plan 只含 1→2 边', () => {
    expect(plan(SESSION_CHAIN, 1).map((e) => [e.from, e.to])).toEqual([[1, 2]]);
  });
});

describe('M-A facts 往返恒等', () => {
  it('纯 v1 夹具：v1 facts → 边 → v2 行 → 再归一化，逐面相等', () => {
    const fx = pureV1();
    const form = formOf(fx.header, fx.rows, fx.journal, fx.subcalls);
    const { rows } = migrateSessionForm({ version: 1, value: form });
    expect(rows.length).toBeGreaterThan(0);
    expectFactsEqual(form.facts, factsOfV2Rows(rows));
  });

  it('过渡态夹具：v1 头 + v2 词汇行混入（归一化已处理，边照常工作）', () => {
    const fx = pureV1();
    // 过渡态 = writer 停 v1 后向既有文件追加 v2 行——messages 里混入 step 行
    (fx.rows as unknown as Array<Record<string, unknown>>).push(
      { type: 'step/reasoning', run: 'run-2', step: 0, text: '新词汇行思考', ts: T0 + 60_000, seq: 7 },
      { type: 'run-end', run: 'run-2', finish: 'completed', ts: T0 + 61_000, seq: 8 },
    );
    const form = formOf(fx.header, fx.rows, fx.journal, fx.subcalls);
    const { rows } = migrateSessionForm({ version: 1, value: form });
    expectFactsEqual(form.facts, factsOfV2Rows(rows));
  });

  it('坏行语义：撕裂行 readLedger 层已滤（不进 facts）；未知 type 行归一化兜底进 speech——边如实重放恒等', () => {
    const fx = pureV1();
    // 未知 type 行（v1 role 判别兜底 → speech——归一化层既有语义）
    (fx.rows as unknown as Array<Record<string, unknown>>).push({ type: 'unknown-future', content: '孤儿行', message_id: 'm-3', timestamp: ISO(T0 + 40_000), agent_id: 'agent-a' } as never);
    const form = formOf(fx.header, fx.rows, fx.journal, fx.subcalls);
    expect(form.facts.speech.length).toBe(3); // 含兜底行
    const { rows } = migrateSessionForm({ version: 1, value: form });
    expectFactsEqual(form.facts, factsOfV2Rows(rows));
    // 兜底行迁移后仍在（恒等携带——不静默丢）
    expect(factsOfV2Rows(rows).speech.some((s) => s.messageId === 'm-3')).toBe(true);
  });

  it('subcalls 档案夹具：段行（聚合轨迹）内联 subcall 卡后 steps 事实保全', async () => {
    const fx = pureV1();
    // 段行（v1 物化）+ subcalls 档案（cr-803 分流）
    (fx.rows as unknown as Array<Record<string, unknown>>).push({
      role: 'agent', source: 'segment', run: RUN, content: '',
      message_id: 'seg-x', timestamp: ISO(T0 + 25_000), agent_id: 'agent-a',
      steps: [{ content: '步正文', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}', result: { ok: true, output: 'file-body' } }], ts: T0 + 1500, seq: 2 }],
    } as never);
    fx.subcalls.push({
      type: 'journal-tool-result', run: RUN, toolCallId: 'c1#1',
      result: { ok: true, output: '子调用产物' }, subcall: true,
      name: 'read', arguments: '{}', ts: T0 + 1800, seq: 4,
    });
    const form = formOf(fx.header, fx.rows, fx.journal, fx.subcalls);
    const { rows } = migrateSessionForm({ version: 1, value: form });
    const after = factsOfV2Rows(rows);
    // cr-1307：边直产相位行（段行退役）——subcall 卡按 toolCallId 首段分组
    // 进宿主卡（foldStepsOf 重建投影断言）
    const { foldStepsOf } = await import('../src/fold-core.ts');
    const segRun = after.runs.get(RUN)!;
    const proj = foldStepsOf(segRun, form.subcallArchive as JournalToolResult[]);
    expect(proj).not.toBeNull();
    const flat = proj!.steps[0]!.toolCalls!.map((tc) => tc.id);
    expect(flat).toContain('c1');
    expect(flat).toContain('c1#1');
    // 恒等：v1 侧聚合轨迹（档案内联 + journal duration 补行覆盖——v1 读面
    // projectStep 同语义）与 v2 侧事件重建投影 steps 相等（seq 豁免——产物
    // 行 seq 重排，canonOf 同判据）
    const expectSeg = form.facts.runs.get(RUN)!.aggregated!.map((s) => ({ ...s, ...(s.toolCalls !== undefined ? { toolCalls: s.toolCalls.map((tc) => ({ ...tc })) } : {}) }));
    const { injectSubcallCards } = await import('../src/reader-core.ts');
    injectSubcallCards(expectSeg, form.subcallArchive as JournalToolResult[]);
    for (const line of fx.journal) {
      if (line.type !== 'journal-tool-result') continue;
      for (const s of expectSeg) {
        for (const tc of s.toolCalls ?? []) {
          if (tc.id === line.toolCallId && line.durationMs !== undefined) (tc as typeof tc & { durationMs?: number }).durationMs = line.durationMs;
        }
      }
    }
    const bare = (v: unknown): string => {
      if (Array.isArray(v)) return '[' + v.map(bare).join(',') + ']';
      if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return '{' + Object.keys(o).sort().filter((k) => k !== 'seq').map((k) => JSON.stringify(k) + ':' + bare(o[k])).join(',') + '}';
      }
      return JSON.stringify(v);
    };
    expect(JSON.stringify(bare(proj!.steps))).toBe(JSON.stringify(bare(expectSeg)));
  });

  it('语义收窄点：段行相位序（textBeforeTools）保全——步内正文先于工具', async () => {
    const fx = pureV1();
    (fx.rows as unknown as Array<Record<string, unknown>>).push({
      role: 'agent', source: 'segment', run: RUN, content: '',
      message_id: 'seg-y', timestamp: ISO(T0 + 26_000), agent_id: 'agent-a',
      steps: [{ content: '正文', textBeforeTools: true, toolCalls: [{ id: 'c1', name: 'read', arguments: '{}', result: { ok: true } }], ts: T0 + 1600 }],
    } as never);
    const form = formOf(fx.header, fx.rows, fx.journal, fx.subcalls);
    const { rows } = migrateSessionForm({ version: 1, value: form });
    const after = factsOfV2Rows(rows);
    // cr-1307：textBeforeTools 由行序表达——正文行先于工具行入文件序，
    // foldStepsOf 按首见序推导该字段（fold-core L111 同款判据）
    const { foldStepsOf } = await import('../src/fold-core.ts');
    const seg = foldStepsOf(after.runs.get(RUN)!, [])!.steps[0]!;
    expect(seg.textBeforeTools).toBe(true);
  });
});

describe('M-A injectionId 回填 + 升头', () => {
  it('cr-707 前注入行（无 injectionId）迁移后恒有锚', () => {
    const fx = pureV1();
    const form = formOf(fx.header, fx.rows, fx.journal, fx.subcalls);
    const inj = form.facts.runs.get(RUN)!.events.find((e) => e.kind === 'inject') as { injectionId?: string };
    expect(inj.injectionId).toBeUndefined(); // 夹具无 injectionId（cr-707 前）
    const { rows } = migrateSessionForm({ version: 1, value: form });
    const inj2 = factsOfV2Rows(rows).runs.get(RUN)!.events.find((e) => e.kind === 'inject') as { injectionId?: string };
    expect(inj2.injectionId).toBe('jinj-' + RUN + '-3'); // seq=3 回填
  });

  it('升头：继承旧头全字段 + version:2 + migratedFrom:1', () => {
    const h = v2Header(splitHeader({ type: 'session-header', version: 1, createdAt: ISO(T0), participants: ['user', 'agent-a'], kind: 'user', migrated: true }));
    expect(h).toEqual({
      type: 'session-header', version: 2,
      createdAt: ISO(T0), participants: ['user', 'agent-a'], kind: 'user',
      migrated: true, migratedFrom: 1,
    });
  });
});
