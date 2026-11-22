// ============================================================
// core.test.ts —— 文法/边界单源测试（cr-1245 B1）
// 红绿锚：改 compactionBoundaryOf / rowShadowedBy / domainFactsOf 任一
// 判据即红——8+2 案回归锁的纯核半边（行为锁半边在 ac-ledger 既有测试）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { compactionBoundaryOf, domainFactsOf } from '../src/events-core.ts';
import { rowShadowedBy } from '../src/fold-core.ts';
import type { LedgerRow } from '../src/records.ts';

describe('compactionBoundaryOf（cr-1245 B1 单源——cr-1192/cr-1156 回归锚）', () => {
  it('declared 大于 0 取声明值', () => {
    expect(compactionBoundaryOf(1323, 1465)).toBe(1323);
  });
  it('declared 为 0/负/缺席（存量老 writer 显式写 0 现场）回落事件自身 seq', () => {
    expect(compactionBoundaryOf(0, 42)).toBe(42);
    expect(compactionBoundaryOf(undefined, 42)).toBe(42);
    expect(compactionBoundaryOf(-1, 42)).toBe(42);
  });
  it('双双缺席为 0（无边界——读面同判无效）', () => {
    expect(compactionBoundaryOf(undefined, undefined)).toBe(0);
  });
});

describe('rowShadowedBy（cr-1160 P2 三级裁决——cr-1156/cr-1191 回归锚）', () => {
  const b = { boundarySeq: 100, endTs: 1000 };
  it('时刻放行前置：落账时刻晚于收束时刻恒 kept（seq 倒挂现场）', () => {
    expect(rowShadowedBy({ seq: 50, ts: 2000 }, b)).toBe(false);
  });
  it('位置维：seq 小于等于 boundarySeq 即 shadowed', () => {
    expect(rowShadowedBy({ seq: 100 }, b)).toBe(true);
    expect(rowShadowedBy({ seq: 101 }, b)).toBe(false);
  });
  it('时刻维（无 seq 行）：ts 小于等于 endTs 即 shadowed', () => {
    expect(rowShadowedBy({ ts: 999 }, b)).toBe(true);
    expect(rowShadowedBy({ ts: 1001 }, b)).toBe(false);
  });
  it('文件位置维兜底：v1 无 seq 无 ts 行按 beforeEvent（保守放行）', () => {
    expect(rowShadowedBy({}, b, true)).toBe(true);
    expect(rowShadowedBy({}, b)).toBe(false);
  });
});

describe('domainFactsOf（归一化纯核——cr-1190 混合会话回归锚）', () => {
  it('v1 头行混合 v2 事件行：按行面判别不按头行（版本判据 = 行面）', () => {
    const rows: LedgerRow[] = [
      { type: 'message', role: 'agent', content: '答', agent_id: 'a', message_id: 'm1', timestamp: '2026-11-20T10:00:00.000Z', seq: 2 } as LedgerRow,
      { role: 'agent', content: '旧', agent_id: 'user', message_id: 'm0', timestamp: '2026-11-20T09:00:00.000Z' } as LedgerRow,
    ];
    const facts = domainFactsOf('a', 1, rows, [], []); // 头行 version=1 而行面已 v2
    expect(facts.speech).toHaveLength(2); // 两代行都在场——不因头行 v1 丢行
  });
  it('未知 type 且无 role 的裸行不进任何事件面（撕裂/异形行容错——读侧保守）', () => {
    // 无 role 键的未知 type 行：V2_TYPES 外 → v1 分支 role 判别 miss →
    // 不进 speech/contexts（保守读——撕裂行不入事件面）
    const rows: LedgerRow[] = [
      { type: 'who-knows', content: 'x', agent_id: 'a', message_id: 'm9', timestamp: '', role: 'context', source: 'skill' } as unknown as LedgerRow,
    ];
    const facts = domainFactsOf('a', 2, rows, [], []);
    expect(facts.contexts).toHaveLength(1); // role=context 走 v1 判别面
    expect(facts.speech).toHaveLength(0);
  });
});
