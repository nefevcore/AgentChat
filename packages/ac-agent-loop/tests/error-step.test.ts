import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmMessage, LlmStreamChunk } from 'ac-llm';
import type { LoopStepRecord } from '../src/contract.ts';
import * as llmRow from 'ac-llm';
import * as loopRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';

// ---- 错误步保真（cr-1042）：LLM 流中途失败时的部分聚合照常入档 ----
// chat() 对流中途失败（已产出内容）返回部分结果（aborted: true +
// streamError），loop 据此：
//   · 步记录入 steps + after-step 照发（journal 落盘——失败前已流出的
//     思考/正文是会话事实，刷新后不蒸发）；
//   · 跳过工具执行（toolCalls 可能不完整）；
//   · finish='error' + error=streamError（红条文案同源）。

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

describe('错误步保真（cr-1042）', () => {
  it('流中途失败（已产出内容）→ 部分思考/正文档 + error 收束带原因', async () => {
    const afterSteps: LoopStepRecord[] = [];
    const ctx = await boot(() => ({
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { delta: '', reasoning: '想了一半' };
        yield { delta: '半截正文' };
        throw new Error('ECONNRESET 网络故障');
      },
    }));
    ctx.on('loop/after-step', (_agent: string | undefined, step: LoopStepRecord) => {
      afterSteps.push(step);
    });
    const result = await ctx.agentLoop.run({
      model: 'mock-1', messages: USER('嗨'),
    });
    // 错误步入档：部分 reasoning/text + aborted 标记 + 失败原因
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].aborted).toBe(true);
    expect(result.steps[0].streamError).toContain('ECONNRESET');
    expect(result.steps[0].reasoning).toBe('想了一半');
    expect(result.steps[0].text).toBe('半截正文');
    expect(result.steps[0].toolResults).toEqual([]);
    // after-step 照发（journal 落盘的订阅面）
    expect(afterSteps).toHaveLength(1);
    expect(afterSteps[0].aborted).toBe(true);
    // 收束语义：error + 原因（供红条/落盘 errorMessage）
    expect(result.finish).toBe('error');
    expect(result.error).toContain('ECONNRESET');
  });

  it('带不完整 tool_calls 的错误步 → 工具不执行（调用形状如实入档）', async () => {
    let echoRuns = 0;
    const ctx = await boot(() => ({
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        yield { delta: '', reasoning: '先想' };
        yield { delta: '', toolCalls: [{ index: 0, id: 'tc-x', name: 'echo' }] };
        throw new Error('ECONNRESET 网络故障');
      },
    }));
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      execute: () => { echoRuns += 1; return { ok: true, output: 'x' }; },
    });
    const result = await ctx.agentLoop.run({
      model: 'mock-1', messages: USER('嗨'),
    });
    // 聚合到的调用分片（有 id/name）如实入步记录——但执行被跳过
    expect(result.steps[0].toolCalls.length).toBe(1);
    expect(result.steps[0].toolResults).toEqual([]);
    expect(echoRuns).toBe(0);
    expect(result.finish).toBe('error');
  });

  it('首块前失败（无内容可保真）→ 无步 + error 收束（原语义）', async () => {
    const ctx = await boot(() => ({
      stream: async function* (): AsyncIterable<LlmStreamChunk> {
        throw new Error('ECONNRESET 网络故障');
      },
    }));
    const result = await ctx.agentLoop.run({
      model: 'mock-1', messages: USER('嗨'),
    });
    expect(result.steps).toHaveLength(0);
    expect(result.finish).toBe('error');
    expect(result.error).toContain('ECONNRESET');
  });
});