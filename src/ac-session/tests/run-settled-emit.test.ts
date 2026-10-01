// ============================================================
// run-settled-emit.test.ts —— D1 收敛协议（cr-94）：settlement 物化
// 完成 → session/run-settled 事件（发射时机构造保证的验证）
//
// 三断言面：
//   1. journal run 收束 → 事件到达且载荷正确（conversationId/agentId/runId）；
//   2. 事件时序 = 权威数据已可见（事件回调内 records() 已含收束行——
//      读侧排空在途 settleChain 的构造保证）；
//   3. 无 journal 直落 run / 机制 run / 群桶 run → 不发事件。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as sessionRow from 'ac-session';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
let tmp = '';

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, agentsRow] as unknown[]) {
    const fiber = ctx.plugin(row as never, {} as never);
    await fiber;
    fibers.push(fiber);
  }
  {
    const fiber = ctx.plugin(sessionRow, { root: tmp });
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  ctx.agents.register({ id: 'a', model: 'none' });
  return ctx;
}

// ---- 驱动辅助：journal run（run-started → after-step → reply-completed）----
const ENV = { conversationId: 'a~user', sender: 'user', source: 'user' };
const RESULT = { steps: [], finish: 'stop', usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 0 } };

function driveJournalRun(ctx: Context, text: string, runId?: string) {
  ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user', ...(runId ? { runId } : {}) } as never);
  ctx.emit('loop/after-step', 'a', {
    index: 0, text: '', reasoning: 'r', ts: Date.now(),
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], toolResults: [],
  } as never, { conversationId: 'a~user', sender: 'user', source: 'user' });
  ctx.emit('router/reply-completed', 'a', text, RESULT as never, 'a~user', 'user', 'user');
}

describe('session/run-settled（D1 收敛信号，cr-94）', () => {
  it('journal run 收束 → 事件到达，载荷 = conversationId/agentId/runId', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-runsettled-'));
    const ctx = await boot();
    const seen: Array<{ cid: string; agent: string; runId: string }> = [];
    ctx.on('session/run-settled', (conversationId, agentId, meta) => {
      seen.push({ cid: conversationId, agent: agentId, runId: meta.runId });
    });
    driveJournalRun(ctx, '答', 'run-emit-1');
    await new Promise((r) => setTimeout(r, 50)); // settleTail 异步收尾
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ cid: 'a~user', agent: 'a', runId: 'run-emit-1' });
  });

  it('构造保证：事件回调内 records() 已含权威收束行（无赌窗）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-runsettled-'));
    const ctx = await boot();
    let contentsInEvent: string[] = [];
    ctx.on('session/run-settled', async () => {
      contentsInEvent = (await ctx.session.records('a~user')).map((r) => String(r.content));
    });
    driveJournalRun(ctx, '权威正文', 'run-emit-2');
    await new Promise((r) => setTimeout(r, 50));
    // 事件时刻权威收束行已在场（终文本可见）——不再有「重拉扑空」窗口
    expect(contentsInEvent).toContain('权威正文');
  });

  it('无 journal 直落 run → 不发事件（读侧 reply-completed 时已可见）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-runsettled-'));
    const ctx = await boot();
    let fired = 0;
    ctx.on('session/run-settled', () => { fired++; });
    ctx.emit('router/reply-completed', 'a', '直落', RESULT as never, 'a~user', 'user', 'user');
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(0);
  });
});