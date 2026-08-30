// ============================================================
// ac-agent-loop M9：steer 注入 / started 通知事件 / interrupted 中断
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmMessage, LlmStreamChunk } from 'ac-llm';
import { runAddress } from '../src/index.ts';
import * as llmRow from 'ac-llm';
import * as loopRow from '../src/index';
import * as toolsRow from 'ac-tools';

// ---- 脚手架（同 loop.test.ts：脚本化 provider，第 n 次调用出第 n 套片） ----

interface Script {
  calls: LlmChatInput[];
  chunks: (input: LlmChatInput) => LlmStreamChunk[];
}

let counter = 0;

function scriptedProvider(scripts: Script[]) {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      const idx = Math.min(scripts.length - 1, counter++);
      scripts[idx].calls.push(input);
      yield* scripts[idx].chunks(input);
    },
  });
}

function textChunks(text: string, usage = { prompt: 1, completion: 1 }): LlmStreamChunk[] {
  return [{ delta: text.slice(0, 1) }, { delta: text.slice(1) }, { delta: '', finish: 'stop', usage }];
}

function toolCallChunks(id: string, name: string, args: string): LlmStreamChunk[] {
  return [
    { delta: '', toolCalls: [{ index: 0, id, name }] },
    { delta: '', toolCalls: [{ index: 0, argumentsDelta: args }] },
    { delta: '', finish: 'tool_calls' },
  ];
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(scripts: Script[]) {
  counter = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(scripts), { models: ['mock-1'] });
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
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

const USER = (text: string): LlmMessage[] => [{ role: 'user', content: text }];

describe('runAddress（steer/串行化门共用的寻址词汇）', () => {
  it('agent 缺省 → 无地址；conversationId 缺省/=agent → agent；群聊 → conversationId~agent', () => {
    expect(runAddress(undefined, undefined)).toBeUndefined();
    expect(runAddress('a1', undefined)).toBe('a1');
    expect(runAddress('a1', 'a1')).toBe('a1');
    expect(runAddress('a1', 'g1')).toBe('g1~a1');
  });
});

describe('steer 注入（Service 方法，ADR-1）', () => {
  it('run 中注入 → 下一步消息含注入内容；run 结束后队列回收', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'steer_now', '{}') };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({
      name: 'steer_now',
      execute: () => {
        // 工具执行中注入（对齐 src pushSteer 竞态场景）
        const ok = ctx.agentLoop.steer('a1', { role: 'user', content: '中途插入指令' });
        expect(ok).toBe(true);
        return { ok: true };
      },
    });
    const result = await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      messages: USER('开始'),
      conversationId: 'a1',
    });
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(2);
    const contents = s2.calls[0].messages.map((m) => m.content);
    expect(contents).toContain('中途插入指令');
    // run 已收束 → 同地址无活跃 run
    expect(ctx.agentLoop.steer('a1', { role: 'user', content: '迟到的' })).toBe(false);
  });

  it('末轮注入不丢失：自然收束步之后仍有 steer → 追加一步消费', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('先回答一半') };
    const s2: Script = { calls: [], chunks: () => textChunks('补充完成') };
    const { ctx } = await boot([s1, s2]);
    let stepSeen = 0;
    ctx.on('loop/before-step', (call, next) => {
      // 首步的 before-step 阶段注入：本步排水已过 → 留给下一步（末轮场景）
      if (stepSeen++ === 0) {
        ctx.agentLoop.steer('a1', { role: 'user', content: '等等，还有一件事' });
      }
      return next();
    });
    const result = await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      messages: USER('q'),
      conversationId: 'a1',
    });
    expect(result.steps).toHaveLength(2); // 末轮 steer 驱动追加一步
    expect(result.text).toBe('补充完成');
    expect(s2.calls[0].messages.map((m) => m.content)).toContain('等等，还有一件事');
  });

  it('before-run 阶段即可注入（注册先于拦截链）→ 首步消费', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('ok') };
    const { ctx } = await boot([s1]);
    ctx.on('loop/before-run', (call, next) => {
      ctx.agentLoop.steer('a1', { role: 'user', content: '开跑前注入' });
      return next();
    });
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', messages: USER('q'), conversationId: 'a1' });
    expect(s1.calls[0].messages.map((m) => m.content)).toContain('开跑前注入');
  });

  it('群聊地址按参与者区分：同组两个 agent 各自独立队列', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'steer_b', '{}') };
    const s2: Script = { calls: [], chunks: () => textChunks('b 的回答') };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({
      name: 'steer_b',
      execute: () => {
        // 向"组内另一个参与者"注入 → 地址不同 → false
        expect(ctx.agentLoop.steer('g1~b1', { role: 'user', content: 'x' })).toBe(false);
        expect(ctx.agentLoop.steer('g1~a1', { role: 'user', content: '给 a1 的' })).toBe(true);
        return { ok: true };
      },
    });
    const result = await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      messages: USER('q'),
      conversationId: 'g1',
    });
    expect(result.finish).toBe('stop');
    expect(s2.calls[0].messages.map((m) => m.content)).toContain('给 a1 的');
  });

  it('agent 缺省（subagent 直连形态）→ 无地址，steer 不适用', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('ok') };
    const { ctx } = await boot([s1]);
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(ctx.agentLoop.steer('a1', { role: 'user', content: 'x' })).toBe(false);
  });
});

describe('loop/run-started 与 loop/step-started（emit 通知）', () => {
  it('顺序：run-started → step-started×N → after-run；载荷正确', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'echo', '{}') };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true }) });
    const order: string[] = [];
    let stepMessages = 0;
    ctx.on('loop/run-started', (request) => order.push(`run:${request.agent}:${request.conversationId}`));
    ctx.on('loop/step-started', (_agent, index, messages) => {
      order.push(`step:${index}`);
      stepMessages = messages.length;
    });
    ctx.on('loop/after-run', (_req, result) => order.push(`after:${result.finish}`));
    await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      messages: USER('q'),
      conversationId: 'a1',
    });
    expect(order).toEqual(['run:a1:a1', 'step:0', 'step:1', 'after:stop']);
    expect(stepMessages).toBeGreaterThan(0); // 载荷 = 实际送入模型的消息
  });

  it('veto → run-started 不发（before-run 未通过）', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('不应出现') };
    const { ctx } = await boot([s1]);
    let started = 0;
    ctx.on('loop/run-started', () => started++);
    ctx.on('loop/before-run', () =>
      Promise.resolve({ steps: [], text: '[拦截]', finish: 'veto' as const, usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } }),
    );
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.finish).toBe('veto');
    expect(started).toBe(0);
  });
});

describe('finish:interrupted（ADR-2 最小中断方案）', () => {
  it('预中止 signal → 零步收尾，finish interrupted + interruptReason', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('不应出现') };
    const { ctx } = await boot([s1]);
    const controller = new AbortController();
    controller.abort();
    const result = await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      messages: USER('q'),
      signal: controller.signal,
    });
    expect(result.finish).toBe('interrupted');
    expect(result.steps).toHaveLength(0);
    // Node 的无参 abort() 自带 DOMException reason（"This operation was aborted"）
    expect(result.interruptReason?.type).toBe('user-abort');
    expect(typeof result.interruptReason?.reason).toBe('string');
    expect(s1.calls).toHaveLength(0); // LLM 未被调用
  });

  it('run 中中止（工具执行期 abort）→ 保留已完成步，interruptReason 带细节', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'abort_now', '{}') };
    const s2: Script = { calls: [], chunks: () => textChunks('不应出现') };
    const { ctx } = await boot([s1, s2]);
    const controller = new AbortController();
    ctx.tools.register({
      name: 'abort_now',
      execute: () => {
        controller.abort(new Error('用户取消了'));
        return { ok: true };
      },
    });
    const result = await ctx.agentLoop.run({
      agent: 'a1',
      model: 'mock-1',
      messages: USER('q'),
      signal: controller.signal,
    });
    expect(result.finish).toBe('interrupted');
    expect(result.steps).toHaveLength(1); // 已完成步保留
    expect(result.interruptReason).toEqual({ type: 'user-abort', reason: '用户取消了' });
    expect(s2.calls).toHaveLength(0); // 下一步未发生
  });

  it('interrupted run 仍走 transform-run + after-run（事件面闭合）', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('ok') };
    const { ctx } = await boot([s1]);
    const controller = new AbortController();
    controller.abort();
    let afterFinish = '';
    ctx.on('loop/after-run', (_req, result) => (afterFinish = result.finish));
    const result = await ctx.agentLoop.run({
      model: 'mock-1',
      messages: USER('q'),
      signal: controller.signal,
    });
    expect(result.finish).toBe('interrupted');
    expect(afterFinish).toBe('interrupted');
  });
});
