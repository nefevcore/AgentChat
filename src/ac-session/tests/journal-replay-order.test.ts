// ============================================================
// journal-replay-order.test.ts —— journal 活投影行时序（注入行不坠尾）
//
// 背景（2026-12 顺序反馈）：records() 把 journal-inject 行投影为 timestamp
// = 读取时刻——刷新时注入行恒最新，前端按 ts 排序后注入行被挤到队尾
//（[s1, s2, inject, s3] → [s1, s2, s3, inject]）。步行同款问题已修
//（timestamp = 步内 ts）；本文件钉住注入行同款修复 + 混排真实序。
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as agentsRow from 'ac-agents';
import * as sessionRow from '../src/index.ts';

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-jord-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
async function boot(root: string) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [agentsRow, sessionRow] as any[]) {
    const fiber = ctx.plugin(row, { root });
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).agents && (ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('journal 活投影行时序（运行中刷新回放顺序）', () => {
  it('run 进行中：注入行 timestamp = 注入时刻（步间），步行 = 步内 ts', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'alpha', model: 'none' });
    const conv = 'alpha~user';

    // 走真实事件链：run-started（服务端铸造 run id + 簿记）→ after-step
    // 落 journal 步行（flushBestEffort 即时落盘）——手写 partials 的 run id
    // 无法对上服务端簿记（genRunId 铸造），会被 recoverJournal 判孤儿收口。
    // 注入行走 recordContext（run 活跃 → journal context 注入行）——与
    // steer 消费点同形（JournalInjectLine 带 ts）。
    const env = { conversationId: conv, sender: 'user' };
    ctx.emit('loop/run-started', { agent: 'alpha', conversationId: conv, sender: 'user', source: 'user' } as never);
    await new Promise((r) => setTimeout(r, 10));
    // 真实墙钟时间线（步 ts 与注入 ts 同源递增——伪造过去时刻会与注入的
    // 真实 Date.now() 倒挂，测不出相对序）：s1 → s2 → 注入 → s3。间隔 20ms
    // （Windows 计时粒度 ~15ms——5ms 不保证跨毫秒，等时刻会退化成 seq 序断言）
    const step = async (i: number, text: string) => {
      // ts 恒带（真实 loop 层在 after-step emit 前盖章 Date.now()——
      // service.ts transform-step 后恒有；缺它服务端回落读取时刻，测不出步序）
      ctx.emit('loop/after-step', 'alpha', { index: i, text, reasoning: '', toolCalls: [], toolResults: [], ts: Date.now() } as never, env);
      await new Promise((r) => setTimeout(r, 20));
    };
    await step(0, 's1');
    await step(1, 's2');
    // 技能注入等 context 行（run 活跃 → journal-inject，ts = 注入时刻）
    (ctx.session as any).recordContext?.(conv, 'alpha', '中途插入的问题', { source: 'skill', label: '技能注入' });
    await new Promise((r) => setTimeout(r, 20));
    await step(2, 's3');
    // flushBestEffort 落盘 + 不发 after-run（run 在途——刷新场景）
    await new Promise((r) => setTimeout(r, 50));

    const records = await ctx.session.records(conv);
    const ts = (c: string) => {
      const hit = records.find((r: any) => r.content === c);
      expect(hit, 'records 缺行: ' + c).toBeDefined();
      return Date.parse((hit as { timestamp: string }).timestamp);
    };
    const tS1 = ts('s1');
    const tS2 = ts('s2');
    const tInj = ts('中途插入的问题'); // recordContext 注入行（context 形态）
    const tS3 = ts('s3');
    // 步行 timestamp = 步内 ts（上一轮修复）；注入行 timestamp = 注入时刻
    // （本轮修复——此前恒"读取时刻"，刷新时被排到队尾）。真实墙钟时间线下
    // 相对序必须成立：s1 < s2 < 注入 < s3。
    expect(tS1).toBeLessThan(tS2);
    expect(tS2).toBeLessThan(tInj);
    expect(tInj).toBeLessThan(tS3);
    // 注入时刻必须显著早于本次 records() 读取（修复前恒 ≈ 读取时刻）
    expect(tInj).toBeLessThan(Date.now() - 5);
  });
});
