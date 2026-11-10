// ============================================================
// p3-event-appended.test.ts —— cr-976 直播管线 B 案 ledger 半边：
// 落账切片 durable 后泛化通知 ledger/event-appended（D3-2——step-journaled
// 的泛化形态）。断言面：
//   · 步相位批：rows = journalStep 切片内追加行全集（含 seq，行序即步内序）
//   · 收束切片：终稿 message 行 + run-end 行同批（E-2 因果链数据源——
//     宿主据此投影 run/settled，落盘通知与重拉权威同一事实）
//   · 工具结果行：单行批（tool/after-execute 落账面）
//   · 注入行：单行批（inject 不投影前端帧，通知仍发射——消费方自决）
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionDir } from '../src/writer.ts';

const ROOT = path.join('sandbox', 'test-ledger-p3-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const uuid = '0192aaaa-bbbb-7ccc-8ddd-eeeeffff2001';

type Appended = { agent: string; conversationId: string; rows: Array<Record<string, unknown>> };

async function bootLedger(root: string, agentId: string): Promise<{ ctx: import('@agentchat/cordis').Context; got: Appended[]; stop(): Promise<void> }> {
  const { Context } = await import('@agentchat/cordis');
  const { makeLedgerRow } = await import('../src/service.ts');
  const ctx = new Context();
  const fiber = ctx.plugin(makeLedgerRow({ dataRoot: root, agentId }));
  await fiber;
  const got: Appended[] = [];
  ctx.on('ledger/event-appended', (p: Appended) => { got.push(p); });
  return {
    ctx,
    got,
    async stop() { await fiber.dispose(); },
  };
}

describe('ledger/event-appended（cr-976 泛化通知）', () => {
  it('journalStep：步相位批 rows 全集 + 行序即步内序 + seq 与落盘行一致', async () => {
    const h = await bootLedger(ROOT, 'p3a');
    try {
      await (h.ctx.ledger as unknown as { journalStep(u: string, r: string, s: unknown): Promise<void> })
        .journalStep(uuid, 'run-p', { index: 0, stepId: 'run-p:0', reasoning: '思考', text: '正文', toolCalls: [{ id: 'c1', name: 'hello', arguments: '{}' }], toolResults: [] });
      expect(h.got).toHaveLength(1);
      const p = h.got[0]!;
      expect(p).toMatchObject({ agent: 'p3a', conversationId: uuid });
      expect(p.rows.map((r) => r.type)).toEqual(['step/reasoning', 'step/tool-call', 'step/content']);
      // 行序即步内序（cr-946 相位序：正文先行步 text 先于工具调用行）
      const seqs = p.rows.map((r) => r.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => (a as number) - (b as number)));
      // 载荷行即落盘行（durable 后通知——读回对拍）
      const { readLedger } = await import('../src/reader.ts');
      const rows = readLedger(sessionDir(ROOT, 'p3a', uuid)).rows as unknown as Array<Record<string, unknown>>;
      expect(rows.filter((r) => String(r.type).startsWith('step/')).map((r) => r.seq)).toEqual(seqs);
    } finally { await h.stop(); }
  });

  it('settleRun：终稿 message + run-end 同批（收束切片原子）', async () => {
    const h = await bootLedger(ROOT, 'p3b');
    try {
      await (h.ctx.ledger as unknown as {
        settleRun(u: string, p: string[], k: string, row: unknown, runId: string, finish: 'ok' | 'interrupted' | 'error', err?: string): Promise<void>;
      }).settleRun(uuid, ['p3b', 'user'], 'user', { role: 'agent', content: '终稿', agent_id: 'p3b' }, 'run-s', 'ok');
      // settle 切片之前无其他批（首写即收束）
      const batch = h.got.at(-1)!;
      expect(batch.rows.map((r) => r.type)).toEqual(['message', 'run-end']);
      expect(batch.rows[1]).toMatchObject({ run: 'run-s', finish: 'completed' });
      // 终稿行与 run-end 行同批（宿主投影 run/settled 的 text 取源）
      expect(batch.rows[0]).toMatchObject({ content: '终稿' });
    } finally { await h.stop(); }
  });

  it('tool/after-execute 落账：单行 step/tool-call-result 批', async () => {
    const h = await bootLedger(ROOT, 'p3c');
    try {
      h.ctx.emit('tool/after-execute', { agentId: 'p3c', conversationId: uuid, runId: 'run-t', toolCallId: 'call-9', name: 'hello' } as never, { ok: true, output: '输出' } as never, undefined, 30);
      await new Promise((r) => setTimeout(r, 20)); // 落账异步面（void 链）
      const hit = h.got.find((p) => p.rows.some((r) => r.type === 'step/tool-call-result'));
      expect(hit).toBeDefined();
      expect(hit!.rows).toHaveLength(1);
      expect(hit!.rows[0]).toMatchObject({ run: 'run-t', toolCallId: 'call-9', durationMs: 30 });
    } finally { await h.stop(); }
  });

  it('journalInject：单行 inject 批（通知发射——投影取舍归消费方）', async () => {
    const h = await bootLedger(ROOT, 'p3d');
    try {
      await (h.ctx.ledger as unknown as { journalInject(u: string, r: string, c: string, rq?: string): Promise<void> })
        .journalInject(uuid, 'run-i', '插话', 'steer-1');
      const hit = h.got.find((p) => p.rows.some((r) => r.type === 'inject'));
      expect(hit).toBeDefined();
      expect(hit!.rows[0]).toMatchObject({ run: 'run-i', content: '插话', requestId: 'steer-1' });
    } finally { await h.stop(); }
  });
});
