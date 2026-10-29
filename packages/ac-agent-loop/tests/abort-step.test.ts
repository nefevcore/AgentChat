import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmMessage, LlmStreamChunk } from 'ac-llm';
import type { LoopStepRecord } from '../src/contract.ts';
import * as llmRow from 'ac-llm';
import * as loopRow from '../src/index';
import * as toolsRow from 'ac-tools';

// ---- 中止步保真（cr-766）：LLM 流被 abort 时的部分聚合照常入档 ----
// chat() 对 signal 中止返回部分结果（aborted: true），loop 据此：
//   · 步记录入 steps + after-step 照发（journal 落盘——中断前已流出的
//     思考/正文是会话事实）；
//   · 跳过工具执行（toolCalls 可能不完整）；
//   · finish='interrupted' + interruptReason.type='user-abort'。

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(provider: () => { stream(input: LlmChatInput): AsyncIterable<LlmStreamChunk> }) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', provider, { models: ['mock-1'] });
      },
    },
    loopRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

const USER = (text: string): LlmMessage[] => [{ role: 'user', content: text }];

describe('中止步保真（cr-766）', () => {
  it('思考中 abort → 部分思考入 steps + after-step 照发 + interrupted 收束', async () => {
    const controller = new AbortController();
    const afterSteps: LoopStepRecord[] = [];
    const ctx = await boot(() => ({
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { delta: '', reasoning: '想了一半' };
        await new Promise((r) => setTimeout(r, 20));
        controller.abort(new Error('stop 请求'));
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    }));
    ctx.on('loop/after-step', (_agent: string | undefined, step: LoopStepRecord) => {
      afterSteps.push(step);
    });
    const result = await ctx.agentLoop.run({
      model: 'mock-1', messages: USER('嗨'), signal: controller.signal,
    });
    // 中止步入档：部分 reasoning + aborted 标记 + 思考耗时收口
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].aborted).toBe(true);
    expect(result.steps[0].reasoning).toBe('想了一半');
    // 单片思考：起点=末片同帧 → Math.max(1, ·) 兜底 1ms（在场即证明收口路径执行）
    expect(result.steps[0].reasoningMs).toBeGreaterThanOrEqual(1);
    expect(result.steps[0].toolResults).toEqual([]);
    // after-step 照发（journal 落盘的订阅面）
    expect(afterSteps).toHaveLength(1);
    expect(afterSteps[0].aborted).toBe(true);
    // 收束语义：interrupted + user-abort
    expect(result.finish).toBe('interrupted');
    expect(result.interruptReason?.type).toBe('user-abort');
  });

  it('带不完整 tool_calls 的中止步 → 工具不执行（部分调用形状如实入档）', async () => {
    const controller = new AbortController();
    let echoRuns = 0;
    const ctx = await boot(() => ({
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { delta: '', reasoning: '先想' };
        yield { delta: '', toolCalls: [{ index: 0, id: 'tc-x', name: 'echo' }] };
        await new Promise((r) => setTimeout(r, 20));
        controller.abort(new Error('stop 请求'));
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    }));
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      execute: () => { echoRuns += 1; return { ok: true, output: 'x' }; },
    });
    const result = await ctx.agentLoop.run({
      model: 'mock-1', messages: USER('嗨'), signal: controller.signal,
    });
    // 聚合到的调用分片（有 id/name）如实入步记录——但执行被跳过
    expect(result.steps[0].toolCalls.length).toBe(1);
    expect(result.steps[0].toolCalls[0].name).toBe('echo');
    expect(result.steps[0].toolResults).toEqual([]);
    expect(echoRuns).toBe(0);
    expect(result.finish).toBe('interrupted');
  });
});
