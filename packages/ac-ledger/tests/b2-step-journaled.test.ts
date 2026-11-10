// ============================================================
// b2-step-journaled.test.ts —— B2 帧携带 ledger 半边：
//   · writer.appendEvents 返回末行 seq（v2 事件日志——批即语义单元）
//   · journalStep 落盘完成后补发 ledger/step-journaled 锚事件（刻意晚于
//     落盘——cr-707「事件先于落盘」不反转，事件语义即「seq 已 durable」；
//     cr-974 v2：seq = 步内末相位行，落 messages.jsonl 事件日志）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter, sessionDir } from '../src/writer.ts';
import { readJournal, readLedger } from '../src/reader.ts';

const ROOT = path.join('sandbox', 'test-ledger-b2-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff1001';

describe('B2 帧携带：journal seq 返回 + 落盘后锚事件', () => {
  it('writer.appendEvents 返回批末行 seq（与落盘行一致、单调）', async () => {
    const w = new LedgerWriter(sessionDir(ROOT, 'b2a', uuid), { participants: ['b2a', 'user'], kind: 'user' });
    const s1 = await w.appendEvents([{ type: 'step/content', run: 'run-b', step: 0, text: '第一步', ts: 1 }]);
    const s2 = await w.appendEvents([{ type: 'inject', run: 'run-b', content: '注入', ts: 2 }]);
    expect(typeof s1).toBe('number');
    expect(s2).toBeGreaterThan(s1);
    const rows = readLedger(sessionDir(ROOT, 'b2a', uuid)).rows as unknown as Array<{ seq?: number }>;
    expect(rows.find((r) => (r as { type?: string }).type === 'step/content')?.seq).toBe(s1);
    expect(rows.find((r) => (r as { type?: string }).type === 'inject')?.seq).toBe(s2);
    // v2 单文件事件日志：journal 零写入
    expect(readJournal(sessionDir(ROOT, 'b2a', uuid)).some((l) => l.run === 'run-b')).toBe(false);
  });

  it('journalStep 落盘后 emit ledger/step-journaled（载荷 seq 与落盘行一致）', async () => {
    const { Context } = await import('@agentchat/cordis');
    const { makeLedgerRow } = await import('../src/service.ts');
    const ctx = new Context();
    const fiber = ctx.plugin(makeLedgerRow({ dataRoot: ROOT, agentId: 'b2b' }));
    await fiber;
    try {
      const got: Array<Record<string, unknown>> = [];
      ctx.on('ledger/step-journaled', (p: Record<string, unknown>) => { got.push(p); });
      await (ctx.ledger as unknown as { journalStep(u: string, r: string, s: unknown): Promise<void> })
        .journalStep(uuid, 'run-j', { index: 2, stepId: 'run-j:2', text: '想', toolCalls: [], toolResults: [] });
      await (ctx.ledger as unknown as { journalStep(u: string, r: string, s: unknown): Promise<void> })
        .journalStep(uuid, 'run-j', { index: 3, text: '无 stepId 旧形', toolCalls: [], toolResults: [] });
      expect(got).toHaveLength(2);
      expect(got[0]).toMatchObject({ agent: 'b2b', conversationId: uuid, runId: 'run-j', step: 2, stepId: 'run-j:2' });
      expect(typeof got[0]!.seq).toBe('number');
      // stepId 缺席（旧形步记录）不带 stepId 键——前端回落不变
      expect(got[1]).toMatchObject({ agent: 'b2b', conversationId: uuid, runId: 'run-j', step: 3 });
      expect('stepId' in got[1]!).toBe(false);
      // 锚事件携带的 seq 即步内末相位落盘行 seq（已 durable 的身份锚；
      // cr-974 v2——相位行住 messages.jsonl，journal 停写）
      const rows = readLedger(sessionDir(ROOT, 'b2b', uuid)).rows as unknown as Array<Record<string, unknown>>;
      const stepRows = rows.filter((r) => r.type === 'step/content' && r.step === 2);
      expect(stepRows.at(-1)?.seq).toBe(got[0]!.seq);
      // journal 零写入（单文件事件日志——停物化停分流的落盘面断言）
      expect(readJournal(sessionDir(ROOT, 'b2b', uuid)).some((l) => l.run === 'run-j')).toBe(false);
    } finally {
      await fiber.dispose();
    }
  });
});
