import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmProvider, LlmStreamChunk } from 'ac-llm';
import * as llmRow from '../src/index';
import { LlmError } from '../src/service';

// ---- 脚手架：脚本化 mock provider 薄行 ----

interface FactoryCalls {
  factory: number;
  closed: number;
}

function scriptedFactory(script: string[], calls: FactoryCalls, fail = false): () => LlmProvider {
  return () => {
    calls.factory += 1;
    return {
      stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
        if (fail) throw new Error('provider boom');
        for (const piece of script) yield { delta: piece.replace('{model}', input.model) };
        yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: script.length } };
      },
      close: () => {
        calls.closed += 1;
      },
    };
  };
}

function providerRow(name: string, models: string[], factory: () => LlmProvider) {
  return {
    name: `mock-${name}`,
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register(name, factory, { models });
    },
  };
}

const USER = [{ role: 'user' as const, content: 'hi' }];
const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(rows: unknown[] = []) {
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
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-llm 路由', () => {
  it('chat 聚合：provider 直连 + finish/usage', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([
      providerRow('alpha', ['a-1'], scriptedFactory(['你', '好({model})'], calls)),
    ]);
    const result = await ctx.llm.chat({ provider: 'alpha', model: 'a-1', messages: USER });
    expect(result.text).toBe('你好(a-1)');
    expect(result.provider).toBe('alpha');
    expect(result.finish).toBe('stop');
    expect(result.usage).toEqual({ prompt: 1, completion: 2 });
  });

  it('model 路由：精确匹配与前缀匹配', async () => {
    const { ctx } = await boot([
      providerRow('openai', ['gpt-4o'], scriptedFactory(['o({model})'], { factory: 0, closed: 0 })),
      providerRow('deepseek', ['deepseek-chat'], scriptedFactory(['d({model})'], { factory: 0, closed: 0 })),
    ]);
    await expect(ctx.llm.chat({ model: 'gpt-4o', messages: USER })).resolves.toMatchObject({
      text: 'o(gpt-4o)',
      provider: 'openai',
    });
    await expect(ctx.llm.chat({ model: 'deepseek-chat-xl', messages: USER })).resolves.toMatchObject({
      provider: 'deepseek',
    });
  });

  it('懒实例化 + 实例缓存：注册不构造，两次调用一次构造', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([providerRow('lazy', ['l-1'], scriptedFactory(['ok'], calls))]);
    expect(calls.factory).toBe(0);
    expect(ctx.llm.stats().find((s) => s.name === 'lazy')?.instantiated).toBe(false);
    await ctx.llm.chat({ model: 'l-1', messages: USER });
    await ctx.llm.chat({ model: 'l-1', messages: USER });
    expect(calls.factory).toBe(1);
  });

  it('NO_PROVIDER：错误信息含已注册清单', async () => {
    const { ctx } = await boot([providerRow('only', ['m-1'], scriptedFactory(['x'], { factory: 0, closed: 0 }))]);
    await expect(ctx.llm.chat({ model: 'nope', messages: USER })).rejects.toMatchObject({
      name: 'LlmError',
      code: 'NO_PROVIDER',
    });
    expect(() => ctx.llm.resolveProvider({ provider: 'ghost' })).toThrow(LlmError);
  });
});

describe('ac-llm 事件（cordis 事件系统）', () => {
  it('llm/before-chat（waterfall）：变异载体改写输入 → 改写路由', async () => {
    const { ctx } = await boot([
      providerRow('openai', ['gpt-4o'], scriptedFactory(['o({model})'], { factory: 0, closed: 0 })),
      providerRow('deepseek', ['deepseek-chat'], scriptedFactory(['d({model})'], { factory: 0, closed: 0 })),
    ]);
    ctx.on('llm/before-chat', (call, next) => {
      call.input = { ...call.input, model: 'deepseek-chat' };
      return next();
    });
    const result = await ctx.llm.chat({ model: 'gpt-4o', messages: USER });
    expect(result.text).toContain('deepseek-chat');
    expect(result.provider).toBe('deepseek'); // 改写后按最终输入路由
  });

  it('llm/before-chat（waterfall）：不调 next 即短路（缓存回放），provider 未被触达', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([providerRow('real', ['r-1'], scriptedFactory(['x'], calls))]);
    ctx.on('llm/before-chat', () => (async function* () {
      yield { delta: 'cached' };
    })());
    const result = await ctx.llm.chat({ model: 'r-1', messages: USER });
    expect(result.text).toBe('cached');
    expect(calls.factory).toBe(0);
  });

  it('llm/chat-error（emit）：provider 抛错时通知 + chat rejects', async () => {
    const { ctx } = await boot([
      providerRow('bad', ['b-1'], scriptedFactory([], { factory: 0, closed: 0 }, true)),
    ]);
    const seen: unknown[][] = [];
    ctx.on('llm/chat-error', (input, error) => seen.push([input.model, error]));
    await expect(ctx.llm.chat({ model: 'b-1', messages: USER })).rejects.toThrow('provider boom');
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBeInstanceOf(Error);
  });

  it('监听器随注册方 fiber 自动撤销（on → dispose）', async () => {
    const { ctx } = await boot();
    const heard: string[] = [];
    const listenerRow = {
      name: 'mock-listener',
      apply(c: Context) {
        c.on('llm/chat-error', () => heard.push('x'));
      },
    };
    const fiber = ctx.plugin(listenerRow as any);
    await fiber;
    ctx.emit('llm/chat-error', { model: 'm', messages: USER }, new Error('e'));
    expect(heard).toEqual(['x']);
    await fiber.dispose();
    ctx.emit('llm/chat-error', { model: 'm', messages: USER }, new Error('e'));
    expect(heard).toEqual(['x']);
  });
});

describe('ac-llm 流式细分事件（llm/delta-*）', () => {
  it('chat：delta-start → delta×N（含 finish chunk）→ delta-end，顺序保证', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([
      providerRow('s', ['s-1'], scriptedFactory(['你', '好'], calls)),
    ]);
    const trace: string[] = [];
    ctx.on('llm/delta-start', () => trace.push('start'));
    ctx.on('llm/delta', (_i, chunk) => trace.push(chunk.delta || (chunk.finish ? `finish:${chunk.finish}` : '?')));
    ctx.on('llm/delta-end', () => trace.push('end'));
    await ctx.llm.chat({ model: 's-1', messages: USER });
    expect(trace).toEqual(['start', '你', '好', 'finish:stop', 'end']);
  });

  it('stream：逐 chunk 发射 delta（消费节奏即发射节奏）', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([
      providerRow('s', ['s-2'], scriptedFactory(['a', 'b', 'c'], calls)),
    ]);
    const seen: string[] = [];
    ctx.on('llm/delta', (_i, chunk) => seen.push(chunk.delta));
    for await (const _chunk of ctx.llm.stream({ model: 's-2', messages: USER })) {
      // 消费一个 chunk，应恰好看到一个 delta 事件
    }
    // 末个 chunk 是 finish 载体（delta 为空串）——事件如实发射
    expect(seen).toEqual(['a', 'b', 'c', '']);
  });

  it('delta 在拦截链之后：before-chat 改写后的流才被观察', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([
      providerRow('real', ['r-1'], scriptedFactory(['真身'], calls)),
    ]);
    ctx.on('llm/before-chat', () => (async function* () {
      yield { delta: '拦截器替换的流' };
    })());
    const seen: string[] = [];
    ctx.on('llm/delta', (_i, chunk) => seen.push(chunk.delta));
    await ctx.llm.chat({ model: 'r-1', messages: USER });
    expect(seen).toEqual(['拦截器替换的流']);
  });

  it('provider 抛错：delta-end 仍发射（finally 保证），chat-error 同步通知', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx } = await boot([
      providerRow('bad', ['b-1'], scriptedFactory([], calls, true)),
    ]);
    const trace: string[] = [];
    ctx.on('llm/delta-start', () => trace.push('start'));
    ctx.on('llm/delta-end', () => trace.push('end'));
    ctx.on('llm/chat-error', () => trace.push('error'));
    await expect(ctx.llm.chat({ model: 'b-1', messages: USER })).rejects.toThrow('provider boom');
    expect(trace).toEqual(['start', 'error', 'end']);
  });
});

describe('ac-llm fiber 生命周期', () => {
  it('卸载薄行：工厂/实例自动回收（close 被调），路由立即失效', async () => {
    const calls: FactoryCalls = { factory: 0, closed: 0 };
    const { ctx, fibers } = await boot([providerRow('temp', ['t-1'], scriptedFactory(['x'], calls))]);
    await ctx.llm.chat({ model: 't-1', messages: USER }); // 先实例化
    await fibers[1].dispose();
    expect(ctx.llm.providers()).not.toContain('temp');
    expect(calls.closed).toBe(1);
    await expect(ctx.llm.chat({ model: 't-1', messages: USER })).rejects.toMatchObject({
      code: 'NO_PROVIDER',
    });
  });

  it('effect 归属标签进入诊断树', async () => {
    const { fibers } = await boot([providerRow('tagged', ['g-1'], scriptedFactory(['x'], { factory: 0, closed: 0 }))]);
    const labels = fibers[1].getEffects().map((e) => e.label);
    expect(labels).toContain('llm.register(tagged)');
  });
});
