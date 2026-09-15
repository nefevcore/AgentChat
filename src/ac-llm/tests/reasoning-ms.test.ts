import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmProvider, LlmStreamChunk } from 'ac-llm';
import * as llmRow from '../src/index';

// ---- reasoningMs（思考相位时长）聚合：与前端直播 reasoningStartAt 同源定义 ----
// 背景（2026-09-13 反馈）：刷新后的思考卡片 label 无耗时——直播耗时只存在
// 前端内存（StreamState.reasoningStartAt），后端持久化链路从未记录。本测试
// 锁定聚合核：首个 reasoning 片到达 → 首个非 reasoning 片到达的间隔，
// 随 LlmChatResult.reasoningMs 透传（后续 loop → session 落盘 → 历史回放
// 恢复「已思考 · XmYs」）。

interface ScriptPiece {
  chunk: LlmStreamChunk;
  /** 产出本片前等待（ms）——模拟片间到达间隔 */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function scriptedProvider(script: ScriptPiece[]): LlmProvider {
  return {
    stream: async function* (): AsyncIterable<LlmStreamChunk> {
      for (const piece of script) {
        if (piece.waitMs) await sleep(piece.waitMs);
        yield piece.chunk;
      }
    },
  };
}

function providerRow(name: string, provider: LlmProvider) {
  return {
    name: `mock-${name}`,
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(name, () => provider, { models: [name] });
    },
  };
}

const USER = [{ role: 'user' as const, content: 'hi' }];
const booted: { fibers: Fiber[] }[] = [];

async function boot(rows: unknown[]) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const router = ctx.plugin(llmRow);
  await router;
  fibers.push(router);
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ fibers });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('chat 聚合：思考相位时长 reasoningMs', () => {
  // waitMs 语义 = 产出该 piece 前等待（模拟该片到达延迟）——测间隔时挂在
  // 收束片（正文/工具/finish）上，起点片即时到达。
  it('reasoning → 正文：耗时 = 首个 reasoning 片到首个 delta 的间隔', async () => {
    const ctx = await boot([
      providerRow('thinker', scriptedProvider([
        { chunk: { delta: '', reasoning: '先想想' } },
        { chunk: { delta: '', reasoning: '再想想' } },
        { chunk: { delta: '答' }, waitMs: 120 },
      ])),
    ]);
    const result = await ctx.llm.chat({ provider: 'thinker', model: 'thinker', messages: USER });
    expect(result.reasoning).toBe('先想想再想想');
    // 起点 = 首个 reasoning 片到达；收束 = 首个 delta 到达（120ms 后）
    expect(result.reasoningMs).toBeGreaterThanOrEqual(100);
    expect(result.reasoningMs).toBeLessThan(500);
  });

  it('reasoning → 工具分片：思考相位在首个工具分片到达时收束', async () => {
    const ctx = await boot([
      providerRow('tooluser', scriptedProvider([
        { chunk: { delta: '', reasoning: '查一下' } },
        { chunk: { delta: '', toolCalls: [{ index: 0, id: 'tc-1', name: 'read' }] }, waitMs: 120 },
      ])),
    ]);
    const result = await ctx.llm.chat({ provider: 'tooluser', model: 'tooluser', messages: USER });
    expect(result.reasoningMs).toBeGreaterThanOrEqual(100);
    expect(result.reasoningMs).toBeLessThan(500);
  });

  it('纯 reasoning 流（无正文/工具）：以流结束时刻收口', async () => {
    const ctx = await boot([
      providerRow('pure', scriptedProvider([
        { chunk: { delta: '', reasoning: '只思考' } },
        { chunk: { delta: '', finish: 'stop' }, waitMs: 120 },
      ])),
    ]);
    const result = await ctx.llm.chat({ provider: 'pure', model: 'pure', messages: USER });
    expect(result.reasoningMs).toBeGreaterThanOrEqual(100);
  });

  it('无 reasoning：reasoningMs 缺席（不写键）', async () => {
    const ctx = await boot([
      providerRow('plain', scriptedProvider([
        { chunk: { delta: '直答' } },
      ])),
    ]);
    const result = await ctx.llm.chat({ provider: 'plain', model: 'plain', messages: USER });
    expect(result.reasoningMs).toBeUndefined();
  });
});
