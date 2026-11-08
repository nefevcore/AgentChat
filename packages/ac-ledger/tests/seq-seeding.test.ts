// ============================================================
// ac-ledger/tests/seq-seeding.test.ts —— B1 行级 seq 持久化：
// writer 跨实例续接（消灭每实例归零——此前 38 行 13 处回退边）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readLedger, readJournal } from '../src/reader.ts';

const ROOT = path.join('sandbox', 'test-seq-seed-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0b1';

function mk(agentId: string): LedgerWriter {
  const dir = sessionDir(ROOT, agentId, uuid);
  return new LedgerWriter(dir, { participants: [agentId, 'user'], kind: 'user' });
}

describe('B1：seq 跨 writer 实例续接', () => {
  it('新实例首分配从既有 max(seq)+1 起（messages + journal 共面续接）', async () => {
    const dir = sessionDir(ROOT, 'alpha', uuid);
    const w1 = mk('alpha');
    await w1.deliver({ role: 'agent', content: 'a1', agent_id: 'user', requestId: 'r1', uuid });
    await w1.deliver({ role: 'agent', content: 'a2', agent_id: 'user', requestId: 'r2', uuid });
    await w1.journal({ type: 'journal-step', run: 'run1', step: 0, content: 's0' });
    const maxSeq1 = Math.max(
      ...readLedger(dir).rows.map(r => r.seq ?? 0),
      ...readJournal(dir).map(l => l.seq ?? 0),
    );
    // 第二实例（新 run 的 writer）同目录续写
    const w2 = mk('alpha');
    await w2.deliver({ role: 'agent', content: 'b1', agent_id: 'user', requestId: 'r3', uuid });
    const rows = readLedger(dir).rows;
    expect(rows.at(-1)!.seq).toBeGreaterThan(maxSeq1); // 不回退
    // 全文件 seq 严格单调（无归零段）
    const seqs = rows.map(r => r.seq ?? 0);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it('空目录仍从 1 起（首写行为不变）', async () => {
    const w = mk('gamma');
    await w.deliver({ role: 'agent', content: 'x', agent_id: 'user', requestId: 'r1', uuid });
    expect(readLedger(sessionDir(ROOT, 'gamma', uuid)).rows[0]).toMatchObject({ seq: 1 });
  });

  it('存量归零段之后续接：取实际 max 而非行数（旧数据不误判）', async () => {
    const dir = sessionDir(ROOT, 'delta', uuid);
    // 手工落一段「旧格式」行：seq 5 在尾部（存量归零段的尾端）
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    fs.appendFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ type: 'session-header', version: 1, createdAt: 't', participants: ['delta', 'user'], kind: 'user' }) + '\n');
    fs.appendFileSync(path.join(dir, 'messages.jsonl'),
      JSON.stringify({ role: 'agent', content: 'old', message_id: 'm1', timestamp: 't', agent_id: 'user', seq: 5 }) + '\n');
    const w = mk('delta');
    await w.deliver({ role: 'agent', content: 'new', agent_id: 'user', requestId: 'r1', uuid });
    const rows = readLedger(dir).rows;
    expect(rows.at(-1)!.seq).toBe(6); // 从存量 max=5 续接
  });
});
