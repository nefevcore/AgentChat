// ============================================================
// 宿主 usage 行单测（cr-538）：host 端点收信 → 聚合并入账 →
// requestId 幂等 / 非法 payload 拒收不崩 / 非 usage 信直过。
// cr-842：boot 对账回填——journal 计量（事实源）vs audit 对拍补差。
// cr-871：水位增量——已覆盖 session 跳过，新 session 照常补录。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { PostOffice } from 'ac-post-office';
import { makeUsageEnvelope } from 'ac-envelope-core';
import { makeUsageHostRow } from '../src/usage-row.ts';
import { HostInbox } from '../src/host-inbox.ts';

const ROOT = path.join('sandbox', 'test-host-usage-' + process.pid);
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
      expect(fs.readdirSync(path.join(ROOT, 'usage')).filter((f) => f.endsWith('.jsonl')).length).toBe(1);
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

  it('cr-842 对账回填：journal 有 audit 无 → 历史时间戳补录；已到账不补；二次 boot 幂等', async () => {
    // 布置账本：agents/alpha/sessions/s1 的 journal 计量（一条已入 audit、一条丢失）
    const sessDir = path.join(ROOT, 'agents', 'alpha', 'sessions', 's1');
    fs.mkdirSync(path.join(sessDir, 'journal'), { recursive: true });
    const usageA = { prompt: 100, completion: 20, promptAccumulated: 150, totalAccumulated: 170, steps: 2 };
    const usageB = { prompt: 200, completion: 40, promptAccumulated: 300, totalAccumulated: 340, steps: 3 };
    fs.writeFileSync(path.join(sessDir, 'journal', 'partials.jsonl'), [
      JSON.stringify({ type: 'journal-settled', run: 'run-ok', finish: 'ok', usage: usageA, model: 'mock' }),
      JSON.stringify({ type: 'journal-settled', run: 'run-lost', finish: 'ok', usage: usageB, model: 'mock' }),
      // 同 run 无 usage 行（错误收束标记）——不参与对拍
      JSON.stringify({ type: 'journal-settled', run: 'run-err', finish: 'error' }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
    // 同 run 终稿行（run-lost 的时间归属）
    fs.writeFileSync(path.join(sessDir, 'messages.jsonl'), JSON.stringify({
      role: 'agent', content: 'done', agent_id: 'alpha', uuid: 's1',
      run: 'run-lost', timestamp: '2026-10-25T08:00:00.000Z',
    }) + String.fromCharCode(10));
    // audit 侧已有 run-ok（事件信到账过）
    const po0 = new PostOffice({ dataRoot: ROOT });
    const h0 = await boot(po0);
    await h0.dispose(); // boot 时对账（此时 journal 已布置）
    // ↑ 第一次 boot：audit 空 → 两条都补（run-ok 尚未到账场景）。
    //   为构造「一条已到账」，先手工预置 audit 再 boot：
    fs.rmSync(path.join(ROOT, 'usage'), { recursive: true, force: true });
    const po1 = new PostOffice({ dataRoot: ROOT });
    const h1 = await boot(po1);
    try {
      await po1.dispatch(makeUsageEnvelope({ requestId: 'usage-run-ok', payload: meterPayload('run-ok') }));
      // 重启（dispose 后再 boot）：对账扫描发现 run-lost 缺、run-ok 在
      await h1.dispose();
      const po2 = new PostOffice({ dataRoot: ROOT });
      const h2 = await boot(po2);
      try {
        const conv = h2.ctx.usage.byConversation()['s1'];
        expect(conv).toBeDefined();
        // run-ok（信到账 promptAccumulated 150）+ run-lost（补录 300）
        expect(conv.prompt).toBe(150 + 300);
        expect(conv.runs).toBe(2);
        // 历史时间戳生效：run-lost 归日 2026-10-25（终稿行 timestamp）
        const days = h2.ctx.usage.byDay().map((d: any) => d.date);
        expect(days).toContain('2026-10-25');
        // 幂等：三次 boot 对拍为空（差额已补齐）
        await h2.dispose();
        const po3 = new PostOffice({ dataRoot: ROOT });
        const h3 = await boot(po3);
        try {
          expect(h3.ctx.usage.byConversation()['s1'].runs).toBe(2);
        } finally {
          await h3.dispose();
        }
      } finally {
        // h2 已 dispose（幂等段内）；外层 finally 只兜底未 dispose 的
      }
    } finally {
      // h1 已 dispose（重启段内）
    }
  });

  it('cr-871 水位增量：已覆盖 session 跳过（不补不读）；回拨水位 → 照常补录且幂等', async () => {
    // s1：丢失计量 → 首次 boot 全量对账补录 + 落水位
    const s1 = path.join(ROOT, 'agents', 'alpha', 'sessions', 's1');
    fs.mkdirSync(path.join(s1, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(s1, 'journal', 'partials.jsonl'), JSON.stringify({
      type: 'journal-settled', run: 'run-l1', finish: 'ok', model: 'mock',
      usage: { prompt: 10, completion: 2, promptAccumulated: 30, totalAccumulated: 32, steps: 1 },
    }) + '\n');
    const po0 = new PostOffice({ dataRoot: ROOT });
    const h0 = await boot(po0);
    await h0.dispose();
    const wm = path.join(ROOT, 'usage', 'reconcile-watermark.json');
    expect(fs.existsSync(wm)).toBe(true);

    // s2：新丢失行，但水位拨到未来 → s1/s2 全部视为已覆盖 → 不补（跳过实证）
    const s2 = path.join(ROOT, 'agents', 'alpha', 'sessions', 's2');
    fs.mkdirSync(path.join(s2, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(s2, 'journal', 'partials.jsonl'), JSON.stringify({
      type: 'journal-settled', run: 'run-l2', finish: 'ok', model: 'mock',
      usage: { prompt: 20, completion: 4, promptAccumulated: 60, totalAccumulated: 64, steps: 2 },
    }) + '\n');
    fs.writeFileSync(wm, JSON.stringify({ at: new Date(Date.now() + 3600_000).toISOString() }));
    const po1 = new PostOffice({ dataRoot: ROOT });
    const h1 = await boot(po1);
    try {
      expect(h1.ctx.usage.byConversation()['s2']).toBeUndefined(); // 水位前跳过
    } finally {
      await h1.dispose();
    }

    // 水位回拨（等价首次 boot）→ s2 补录；s1 已在 audit（幂等不重复）
    fs.writeFileSync(wm, JSON.stringify({ at: new Date(0).toISOString() }));
    const po2 = new PostOffice({ dataRoot: ROOT });
    const h2 = await boot(po2);
    try {
      expect(h2.ctx.usage.byConversation()['s2']?.runs).toBe(1);
      expect(h2.ctx.usage.byConversation()['s1']?.runs).toBe(1);
    } finally {
      await h2.dispose();
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