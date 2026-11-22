// ============================================================
// doctor.test.ts —— ledger doctor 纯核测试（cr-1245 B4）
// ============================================================
import { describe, it, expect } from 'vitest';
import { scanSeqSpace, scanGrammar, scanClaims } from '../src/doctor.ts';
import { domainFactsOf } from '../src/events-core.ts';
import type { LedgerRow } from '../src/records.ts';
import type { DomainFacts } from '../src/events-core.ts';

const emptyFacts = (domain: string): DomainFacts => domainFactsOf(domain, 2, [], [], []);

describe('scanSeqSpace（INV1——cr-1156/1234 回归锚）', () => {
  it('seq 回退无代解释 → warn', () => {
    const rows = [
      { seq: 5, ts: 100 } as unknown as LedgerRow,
      { seq: 3, ts: 101 } as unknown as LedgerRow,
    ];
    const out = scanSeqSpace(rows, emptyFacts('a'));
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('warn');
  });
  it('行落账晚于代收束（重写窗口）→ 放行', () => {
    const facts = domainFactsOf('a', 2, [
      { type: 'compaction', run: 'c1', boundarySeq: 10, ts: 1000 } as unknown as LedgerRow,
    ] as LedgerRow[], [], []);
    const rows = [
      { seq: 50, ts: 100 } as unknown as LedgerRow,
      { seq: 3, ts: 2000 } as unknown as LedgerRow, // 重写窗口内（ts > endTs）
    ];
    expect(scanSeqSpace(rows, facts)).toHaveLength(0);
  });
  it('洞合法：seq 递增有跳号不报', () => {
    const rows = [
      { seq: 5 } as unknown as LedgerRow,
      { seq: 9 } as unknown as LedgerRow,
    ];
    expect(scanSeqSpace(rows, emptyFacts('a'))).toHaveLength(0);
  });
});

describe('scanGrammar（INV2）', () => {
  it('未知 type 词 → info', () => {
    const rows = [{ type: 'mystery' } as unknown as LedgerRow];
    const out = scanGrammar(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('info');
  });
  it('已知词不报', () => {
    const rows = [{ type: 'message' } as unknown as LedgerRow];
    expect(scanGrammar(rows)).toHaveLength(0);
  });
});

describe('scanClaims（INV3——cr-1214/1229 回归锚）', () => {
  const facts = domainFactsOf('a', 2, [
    { type: 'compaction', run: 'c1', boundarySeq: 10, ts: 1000, stats: { estimatedTokens: 30000 } } as unknown as LedgerRow,
  ] as LedgerRow[], [], []);
  it('主张 vs 重算超阈（max(×2, 1万)）→ error', () => {
    const out = scanClaims(facts, { activeTokens: () => 124000 });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('error');
    expect(out[0]!.invariant).toBe('claim');
  });
  it('增量内偏差（压缩后新内容）→ 放行', () => {
    const out = scanClaims(facts, { activeTokens: () => 40000 });
    expect(out).toHaveLength(0);
  });
});
