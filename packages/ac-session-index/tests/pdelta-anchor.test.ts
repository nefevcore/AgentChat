// ============================================================
// pdelta-anchor.test.ts —— P+delta 锚面（cr-1194）
// 锚 = 末次 run 在 records 的末行时刻（纯 records 自足——journal_lines
// 对多数会话不入账，不作判定依据）；delta = 活跃代 ts_num > 锚 的 est 合计；
// 锚早于末代 compaction end_ts（跨代断层）= null。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionIndex } from '../src/core.ts';

const ROOT0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pdelta-'));
const ROOT = ROOT0;
beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function writeLedger(agent: string, cid: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(ROOT, 'agents', agent, 'sessions', cid);
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('P+delta 锚面（cr-1194）', () => {
  it('锚 = 末次 run 的末行时刻；锚后新行计入 delta，锚前行不计', () => {
    const uuid = 'pd-basic';
    const T = Date.parse('2026-11-21T12:00:00Z');
    writeLedger('alpha', uuid, [
      { role: 'agent', agent_id: 'user', content: '好久以前的消息', message_id: 'm0', timestamp: iso(T - 60_000) },
      { role: 'agent', agent_id: 'user', content: '本 run 的入站', message_id: 'm1', run: 'r1', timestamp: iso(T - 5000) },
      { role: 'agent', agent_id: 'alpha', content: '答', message_id: 'm2', run: 'r1', timestamp: iso(T) },
      { role: 'agent', agent_id: 'user', content: '收束后新行', message_id: 'm3', timestamp: iso(T + 5000) },
    ]);
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const a = idx.pdeltaAnchorOf(ROOT, uuid);
      expect(a).not.toBeNull();
      expect(a!.anchorTs).toBe(T); // run=r1 的末行（'答'）
      expect(a!.estSince).toBeGreaterThan(0); // 只含「收束后新行」
      expect(a!.estSince).toBeLessThan(5);
    } finally { idx.close(); }
  });

  it('从未跑过 run（无带 run 的 records 行）= null', () => {
    const uuid = 'pd-norun';
    writeLedger('alpha', uuid, [
      { role: 'agent', agent_id: 'user', content: '只有消息没跑过', message_id: 'm1', timestamp: iso(Date.now()) },
    ]);
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      expect(idx.pdeltaAnchorOf(ROOT, uuid)).toBeNull();
    } finally { idx.close(); }
  });

  it('跨代断层：锚早于末代 compaction end_ts → null（归档后 P 作废）', () => {
    const uuid = 'pd-cross';
    const T = Date.parse('2026-11-21T12:00:00Z');
    const ARCH = T + 1000;
    writeLedger('alpha', uuid, [
      { role: 'agent', agent_id: 'user', content: '旧代入站', message_id: 'm1', run: 'r1', timestamp: iso(T) },
      { type: 'compaction', run: 'r-arch', boundarySeq: 0, ts: ARCH },
      { role: 'agent', agent_id: 'user', content: '新代消息', message_id: 'm2', timestamp: iso(ARCH + 5000) },
    ]);
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      expect(idx.pdeltaAnchorOf(ROOT, uuid)).toBeNull();
    } finally { idx.close(); }
  });

  it('归档后新 run 重锚：锚晚于末代 end_ts → 有效，delta 只算锚后行', () => {
    const uuid = 'pd-reanchor';
    const T0 = Date.parse('2026-11-21T11:00:00Z');
    const ARCH = T0 + 1000;
    const T1 = ARCH + 10_000;
    writeLedger('alpha', uuid, [
      { role: 'agent', agent_id: 'user', content: '旧代入站', message_id: 'm1', run: 'r1', timestamp: iso(T0) },
      { type: 'compaction', run: 'r-arch', boundarySeq: 0, ts: ARCH },
      { role: 'agent', agent_id: 'user', content: '新代入站', message_id: 'm2', run: 'r2', timestamp: iso(T1) },
      { role: 'agent', agent_id: 'alpha', content: '新代答', message_id: 'm3', run: 'r2', timestamp: iso(T1 + 2000) },
      { role: 'agent', agent_id: 'user', content: '收束后', message_id: 'm4', timestamp: iso(T1 + 6000) },
    ]);
    const idx = new SessionIndex(path.join(ROOT, 'index', 'session-index.db'));
    try {
      idx.refreshConversation(ROOT, uuid);
      const a = idx.pdeltaAnchorOf(ROOT, uuid);
      expect(a).not.toBeNull();
      expect(a!.anchorTs).toBe(T1 + 2000); // 末次 run=r2 的末行
      expect(a!.estSince).toBeGreaterThan(0);
      expect(a!.estSince).toBeLessThan(5);
    } finally { idx.close(); }
  });
});
