// ============================================================
// tests/elev-inherit.test.ts —— 机制唤醒提权继承（goal-round 全链路）
// 场景：用户消息带 full-access 提权（水位写入）→ run 收束 → goal-round
// （source=event，无显式档位）唤醒 → 信封应继承水位 full-access 原样
// （继承不降档——2026-09-12 反馈：降档使唤醒轮逐工具弹审批卡，
// 字幕会话实测 24 次审批）。覆盖 single 会话（UUID 键）与对键两形态。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as agentStoreRow from 'ac-agent-store';
import * as loopRow from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as routerRow from 'ac-router';
import * as convSettingsRow from 'ac-conv-settings';
import * as conversationRow from 'ac-conversation';
import * as goalRow from 'ac-goal';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-elev-repro-'));
  tmps.push(dir);
  return dir;
}

function scriptedProvider() {
  return () => ({
    stream: async function* (_input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot() {
  const root = tmpRoot();
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [agentStoreRow, { root }],
    [llmRow, undefined],
    [{
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    }, undefined],
    [loopRow, undefined],
    [agentsRow, undefined],
    [routerRow, undefined],
    [convSettingsRow, { root }],
    [conversationRow, { root }],
    [goalRow, undefined],
  ];
  for (const [row, config] of rows) {
    const fiber = config === undefined
      ? ctx.plugin(row as never, config as never)
      : ctx.plugin(row as never, config as never);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('机制唤醒提权继承（goal-round × 会话形态）', () => {
  it('single 会话（UUID 键）：用户 full-access → goal-round 原样继承 full-access', { timeout: 30_000 }, async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const seen: string[] = [];
    ctx.on('loop/before-run', (call, next) => {
      seen.push(String((call.request as { elevation?: string }).elevation ?? ''));
      return next();
    }, { description: '测试：记录信封 elevation' });

    // single 会话键（UUID，非对键）
    const sid = '11111111-2222-3333-4444-555555555555';
    // ① 用户消息带 full-access（single：web-api 传 conversationId=sid）
    await ctx.conversation.deliver('a', 'q1', {
      sender: 'user', source: 'user', conversationId: sid, elevation: 'full-access',
    });
    expect(seen[0]).toBe('full-access');
    expect(ctx.convSettings.get(sid).elevation).toBe('full-access');

    // ② 登记 goal → run 收束后 goal-round 投递（source=event，无显式档位）
    await ctx.tools.execute({
      name: 'goal', args: { action: 'create', objective: '测试目标' },
      agentId: 'a', conversationId: sid,
    } as never);
    // 手动广播 after-run（goal-round 触发口；等价于 run 收束事件）
    await ctx.emit('loop/after-run', { agent: 'a', conversationId: sid } as never, { finish: 'stop', steps: [] } as never);
    await new Promise((r) => setTimeout(r, 300)); // maybeContinue 异步投递

    // ③ goal-round run 的信封应继承水位（继承不降档——full 原样）
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toBe('full-access');
  });

  it('对键（a~user）对照：同流程应通过', { timeout: 30_000 }, async () => {
    const { ctx } = await boot();
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const seen: string[] = [];
    ctx.on('loop/before-run', (call, next) => {
      seen.push(String((call.request as { elevation?: string }).elevation ?? ''));
      return next();
    }, { description: '测试：记录信封 elevation' });

    await ctx.conversation.deliver('a', 'q1', {
      sender: 'user', source: 'user', conversationId: 'a~user', elevation: 'full-access',
    });
    expect(seen[0]).toBe('full-access');

    await ctx.tools.execute({
      name: 'goal', args: { action: 'create', objective: '测试目标' },
      agentId: 'a', conversationId: 'a~user',
    } as never);
    await ctx.emit('loop/after-run', { agent: 'a', conversationId: 'a~user' } as never, { finish: 'stop', steps: [] } as never);
    await new Promise((r) => setTimeout(r, 300));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toBe('full-access');
  });
});
