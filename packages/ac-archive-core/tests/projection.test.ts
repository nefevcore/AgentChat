// ============================================================
// projection.test.ts —— 回放投影单源测试（cr-1245 B2）
// 红绿锚：改 replayProjection 任一段（shadow 过滤/伪行合成/摘要头选择）
// 即红。cr-1214（版本判据 = 行面）/cr-1229（伪行计量）回归锁。
// ============================================================
import { describe, it, expect } from 'vitest';
import { replayProjection, replayTokensFor } from '../src/projection.ts';
import { domainFactsOf } from 'ac-ledger-core';
import type { LedgerRow } from 'ac-ledger-core';

const v2Rows = (run: string): LedgerRow[] => [
  { type: 'step/content', run, step: 0, text: '查一下', ts: 100, seq: 1 } as unknown as LedgerRow,
  { type: 'step/tool-call', run, step: 0, toolCallId: 't1', name: 'run_code', arguments: '{}', ts: 101, seq: 2 } as unknown as LedgerRow,
  { type: 'step/tool-call-result', run, toolCallId: 't1', result: { ok: true, output: '结果' }, ts: 102, seq: 3 } as unknown as LedgerRow,
  { type: 'run-end', run, finish: 'completed', ts: 103, seq: 4 } as unknown as LedgerRow,
  { type: 'message', role: 'agent', content: '答', agent_id: 'a', message_id: 'm1', timestamp: '2026-11-22T10:00:00.000Z', seq: 5 } as LedgerRow,
];

describe('replayProjection（cr-1245 B2 单源——cr-1214/1229 回归锚）', () => {
  it('v2 事件行折叠出伪行（估算器口径 = 物化时代恒等）——cr-1229', () => {
    const rows = v2Rows('r1');
    const facts = domainFactsOf('a', 2, rows, [], []);
    const proj = replayProjection(rows, facts, null, { viewer: 'a' });
    expect(proj.pseudo).toHaveLength(1);
    expect(proj.pseudo[0]!.steps).toHaveLength(1);
  });
  it('版本判据 = 行面：头行 v1 而行面 v2 → 伪行照合成（cr-1214 混合会话）', () => {
    const rows = v2Rows('r1');
    const facts = domainFactsOf('a', 1, rows, [], []); // version=1 而行面 v2
    const proj = replayProjection(rows, facts, null, { viewer: 'a' });
    expect(proj.pseudo.length).toBeGreaterThan(0);
  });
  it('伪行计回放口径（steps 展开——不为 0）', () => {
    const rows = v2Rows('r1');
    const facts = domainFactsOf('a', 2, rows, [], []);
    const proj = replayProjection(rows, facts, null, { viewer: 'a' });
    expect(replayTokensFor(proj, 'a')).toBeGreaterThan(0);
  });
  it('activeOnly：代边界后落账的行放行（时刻维），边界前行 shadow', () => {
    const rows: LedgerRow[] = [
      { type: 'compaction', run: 'c1', boundarySeq: 10, ts: Date.parse('2026-11-21T00:00:00.000Z'), seq: 11 } as unknown as LedgerRow,
      { type: 'message', role: 'agent', content: '旧', agent_id: 'a', message_id: 'old', timestamp: '2026-11-20T09:00:00.000Z', seq: 5 } as LedgerRow, // 落账早于收束 → shadow
      { type: 'message', role: 'agent', content: '新', agent_id: 'a', message_id: 'new', timestamp: '2026-11-22T09:00:00.000Z', seq: 12 } as LedgerRow, // 晚于收束 → 时刻放行
    ];
    const facts = domainFactsOf('a', 2, rows, [], []);
    const proj = replayProjection(rows, facts, null, { activeOnly: true, viewer: 'a' });
    expect(proj.picked.some((r) => (r as { message_id?: string }).message_id === 'new')).toBe(true);
    expect(proj.picked.some((r) => (r as { message_id?: string }).message_id === 'old')).toBe(false);
  });
});
