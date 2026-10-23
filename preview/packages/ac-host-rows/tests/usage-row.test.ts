// ============================================================
// 宿主 usage 行单测（cr-538）：host 端点收信 → 聚合并入账 →
// requestId 幂等 / 非法 payload 拒收不崩 / 非 usage 信直过。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { PostOffice } from 'ac-post-office';
import { makeUsageEnvelope } from 'ac-envelope-core';
import { makeUsageHostRow } from '../src/usage-row.ts';
import { HostInbox } from '../src/host-inbox.ts';

const ROOT = path.join('preview', 'sandbox', 'test-host-usage-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function boot(po: PostOffice): Promise<{ ctx: Context; dispose(): Promise<void> }> {
  const ctx = new Context();
  const inbox = new HostInbox(po);
  inbox.start();
  const fiber = ctx.plugin(makeUsageHostRow({ root: ROOT, inbox }));
  await fiber;
  return { ctx, dispose: () => fiber.dispose() };
}

const meterPayload = (runId: string) => ({
  subject: 'usage-run' as const, agent: 'alpha', model: 'mock', finish: 'ok',
  usage: { prompt: 100, completion: 20, promptAccumulated: 150, steps: 2 },
  conversationId: 'user~alpha', runId,
});

describe('宿主 usage 行（事件信收信面）', () => {
  it('usage 信 → 聚合并入账（byAgent prompt = 累加轨）+ 审计流水落盘', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const h = await boot(po);
    try {
      const out = await po.dispatch(makeUsageEnvelope({ requestId: 'usage-run-r1', payload: meterPayload('run-r1') }));
      expect(out[0]).toMatchObject({ to: 'host', channel: 'local', ack: { fresh: true } });
      const byAgent = h.ctx.usage.byAgent();
      expect(byAgent.alpha).toMatchObject({ runs: 1, steps: 2, prompt: 150, completion: 20 });
      // 审计流水（<root>/usage/usage-<date>.jsonl——主线聚合并单源）
      expect(h.ctx.usage.auditFiles().length).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it('requestId 幂等：同 run 重投不重复入账（fresh=false）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const h = await boot(po);
    try {
      const env = makeUsageEnvelope({ requestId: 'usage-run-r1', payload: meterPayload('run-r1') });
      await po.dispatch(env);
      const again = await po.dispatch(env);
      expect(again[0]).toMatchObject({ ack: { fresh: false } });
      expect(h.ctx.usage.byAgent().alpha.runs).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it('非法 payload fail-loud（投递失败转滞留——cr-545 扇出面语义）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const h = await boot(po);
    try {
      const bad = makeUsageEnvelope({
        requestId: 'usage-run-bad',
        payload: { ...meterPayload('run-bad'), agent: '' },
      });
      const out = await po.dispatch(bad);
      // handler 抛错 = local 直调失败 → 发件箱滞留（at-least-once 重试）
      expect(out[0]).toMatchObject({ channel: 'outbox', ack: null });
      expect(h.ctx.usage.byAgent()['']).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it('非 usage 信直过（升级回执 receipt 不误吞）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const h = await boot(po);
    try {
      const env = makeUsageEnvelope({
        requestId: 'receipt-x',
        payload: { ...meterPayload('run-x'), subject: 'upgrade-success' as unknown as 'usage-run' },
      });
      // subject 非 usage-run → isUsageReport false → 直过不入账
      await po.dispatch(env);
      expect(h.ctx.usage.totals().runs).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});