// deliver requestId 幂等准入（cr-250）：同键重发短路 deduped，跨重启持久
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
import * as conversationRow from 'ac-conversation';

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

function textModel() {
  return () => ({
    stream: async function* () {
      await new Promise((r) => setTimeout(r, 120)); // 占住会话窗口（busy 断言前提）
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop' as const, usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(): Promise<Context> {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, { name: 'mock', inject: ['llm'], apply(c: Context) { c.llm.register('mock', textModel(), { models: ['mock-1'] }); } }, agentsRow, loopRow, routerRow] as unknown[]) {
    const fiber = ctx.plugin(row as never, {} as never);
    await fiber;
    fibers.push(fiber);
  }
  {
    const fiber = ctx.plugin(conversationRow, { root: tmp });
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  return ctx;
}

describe('deliver requestId 幂等（cr-250）', () => {
  it('同 requestId 二连投 → 第二次 deduped；无 requestId 不受影响', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-dedup-'));
    const ctx = await boot();
    const o1 = await ctx.conversation.deliver('a', '第一条', { requestId: 'r1', conversationId: 'a~user', sender: 'user' });
    expect(o1.kind).toBe('run');
    const o2 = await ctx.conversation.deliver('a', '第一条', { requestId: 'r1', conversationId: 'a~user', sender: 'user' });
    expect(o2.kind).toBe('deduped');
    // 无 requestId：不短路
    const o3 = await ctx.conversation.deliver('a', '无键', { conversationId: 'a~user', sender: 'user' });
    expect(o3.kind).toBe('run');
  });

  it('重启后同 requestId 重发 → deduped（持久面 .deliver-seen.json）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-dedup-'));
    {
      const ctx = await boot();
      const o = await ctx.conversation.deliver('a', '崩溃前', { requestId: 'rr', conversationId: 'a~user', sender: 'user' });
      expect(o.kind).toBe('run');
      // 模拟崩溃：直接 dispose（不清 afterEach 池——手动管理）
      const entry = booted.pop()!;
      for (const fiber of [...entry.fibers].reverse()) await fiber.dispose();
    }
    const ctx2 = await boot();
    const o2 = await ctx2.conversation.deliver('a', '崩溃前', { requestId: 'rr', conversationId: 'a~user', sender: 'user' });
    expect(o2.kind).toBe('deduped');
  });

  it('busy next-turn 队列 + 重启：pending 恢复后重发同 requestId → deduped（结构性双投根治）', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ac-dedup-'));
    {
      const ctx = await boot();
      const p1 = ctx.conversation.deliver('a', '占住会话', { conversationId: 'a~user', sender: 'user' });
      await new Promise((r) => setTimeout(r, 20));
      const q = await ctx.conversation.deliver('a', '排队消息', { requestId: 'rq', lane: 'next-turn', conversationId: 'a~user', sender: 'user' });
      expect(q.kind).toBe('queued');
      // 崩溃：不消费队列
      void p1;
      const entry = booted.pop()!;
      for (const fiber of [...entry.fibers].reverse()) await fiber.dispose();
    }
    const ctx2 = await boot();
    // 队列已恢复（1 条）；前端重连 flush 重发同 requestId → deduped（不二次入队）
    expect(ctx2.conversation.queue('a', 'a~user').length).toBe(1);
    const o2 = await ctx2.conversation.deliver('a', '排队消息', { requestId: 'rq', lane: 'next-turn', conversationId: 'a~user', sender: 'user' });
    expect(o2.kind).toBe('deduped');
    expect(ctx2.conversation.queue('a', 'a~user').length).toBe(1); // 仍 1 条——未双投
  });
});