// ============================================================
// 宿主 usage 行单测（cr-538；cr-1175 批 2 起服务帧形态）：usage.report
// 受理 → 聚合并入账 → 非法 payload 拒收。cr-842 对账回填 + cr-871 水位
// 增量（与收信通道无关——零改动保留）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from '@agentchat/cordis';
import { makeUsageHostRow } from '../src/usage-row.ts';
import { HostServiceDesk } from '../src/service-desk.ts';

const ROOT = path.join('sandbox', 'test-host-usage-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function boot(): Promise<{ ctx: Context; desk: HostServiceDesk; dispose(): Promise<void> }> {
  const ctx = new Context();
  const desk = new HostServiceDesk();
  const fiber = ctx.plugin(makeUsageHostRow({ root: ROOT, desk }));
  await fiber;
  return { ctx, desk, dispose: () => fiber.dispose() };
}

/** 服务帧直投（report 档——reqId 缺席） */
const report = (desk: HostServiceDesk, payload: unknown): Promise<unknown> =>
  desk.handle({ svc: 'usage.report', reqId: undefined, payload }, null);

const meterPayload = (runId: string) => ({
  subject: 'usage-run' as const, agent: 'alpha', model: 'mock', finish: 'ok',
  usage: { prompt: 100, completion: 20, promptAccumulated: 150, steps: 2 },
  conversationId: 'user~alpha', runId,
});

describe('宿主 usage 行（usage.report 服务帧受理面）', () => {
  it('usage 帧 → 聚合并入账（byAgent prompt = 累加轨）+ 审计流水落盘', async () => {
    const h = await boot();
    try {
      await report(h.desk, meterPayload('run-r1'));
      const byAgent = h.ctx.usage.byAgent();
      expect(byAgent.alpha).toMatchObject({ runs: 1, steps: 2, prompt: 150, completion: 20 });
      // 审计流水（<root>/usage/usage-<date>.jsonl——主线聚合并单源）
      expect(fs.readdirSync(path.join(ROOT, 'usage')).filter((f) => f.endsWith('.jsonl')).length).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it('非法 payload fail-loud（handler 抛错——report 档 W/E 日志即丢，不炸通道）', async () => {
    const h = await boot();
    try {
      await report(h.desk, { ...meterPayload('run-bad'), agent: '' });
      expect(h.ctx.usage.byAgent()['']).toBeUndefined();
      // 通道仍活：好帧照常入账
      await report(h.desk, meterPayload('run-good'));
      expect(h.ctx.usage.byAgent().alpha.runs).toBe(1);
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
    ].join('\n') + '\n');
    // 同 run 终稿行（run-lost 的时间归属）
    fs.writeFileSync(path.join(sessDir, 'messages.jsonl'), JSON.stringify({
      role: 'agent', content: 'done', agent_id: 'alpha', uuid: 's1',
      run: 'run-lost', timestamp: '2026-10-25T08:00:00.000Z',
    }) + '\n');
    // 第一遍 boot：audit 空 → 全补（预置到账场景由下面第二遍承担）
    const h0 = await boot();
    await h0.dispose();
    fs.rmSync(path.join(ROOT, 'usage'), { recursive: true, force: true });
    const h1 = await boot();
    try {
      await report(h1.desk, meterPayload('run-ok'));
      await h1.dispose();
      const h2 = await boot();
      try {
        const conv = h2.ctx.usage.byConversation()['s1'];
        expect(conv).toBeDefined();
        expect(conv.prompt).toBe(150 + 300);
        expect(conv.runs).toBe(2);
        const days = h2.ctx.usage.byDay().map((d: any) => d.date);
        expect(days).toContain('2026-10-25');
        await h2.dispose();
        const h3 = await boot();
        try {
          expect(h3.ctx.usage.byConversation()['s1'].runs).toBe(2);
        } finally {
          await h3.dispose();
        }
      } finally { /* h2 已 dispose */ }
    } finally { /* h1 已 dispose */ }
  });

  it('cr-871 水位增量：已覆盖 session 跳过；回拨水位 → 照常补录且幂等', async () => {
    const s1 = path.join(ROOT, 'agents', 'alpha', 'sessions', 's1');
    fs.mkdirSync(path.join(s1, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(s1, 'journal', 'partials.jsonl'), JSON.stringify({
      type: 'journal-settled', run: 'run-l1', finish: 'ok', model: 'mock',
      usage: { prompt: 10, completion: 2, promptAccumulated: 30, totalAccumulated: 32, steps: 1 },
    }) + '\n');
    const h0 = await boot();
    await h0.dispose();
    const wm = path.join(ROOT, 'usage', 'reconcile-watermark.json');
    expect(fs.existsSync(wm)).toBe(true);

    const s2 = path.join(ROOT, 'agents', 'alpha', 'sessions', 's2');
    fs.mkdirSync(path.join(s2, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(s2, 'journal', 'partials.jsonl'), JSON.stringify({
      type: 'journal-settled', run: 'run-l2', finish: 'ok', model: 'mock',
      usage: { prompt: 20, completion: 4, promptAccumulated: 60, totalAccumulated: 64, steps: 2 },
    }) + '\n');
    fs.writeFileSync(wm, JSON.stringify({ at: new Date(Date.now() + 3600_000).toISOString() }));
    const h1 = await boot();
    try {
      expect(h1.ctx.usage.byConversation()['s2']).toBeUndefined();
    } finally {
      await h1.dispose();
    }

    fs.writeFileSync(wm, JSON.stringify({ at: new Date(0).toISOString() }));
    const h2 = await boot();
    try {
      expect(h2.ctx.usage.byConversation()['s2']?.runs).toBe(1);
      expect(h2.ctx.usage.byConversation()['s1']?.runs).toBe(1);
    } finally {
      await h2.dispose();
    }
  });
});
