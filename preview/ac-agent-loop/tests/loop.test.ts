import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmMessage, LlmStreamChunk } from 'ac-llm';
import type { LoopStepRecord } from '../src/contract.ts';
import * as llmRow from 'ac-llm';
import * as loopRow from '../src/index';
import * as toolsRow from 'ac-tools';

// ---- 脚手架：脚本化 provider（第 n 次调用出第 n 套片，越界复用末套） ----

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

describe('ac-agent-loop 循环', () => {
  it('单步收束：无工具调用 → finish stop，steps 1', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('你好') };
    const { ctx } = await boot([s1]);
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('嗨') });
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(1);
    expect(result.text).toBe('你好');
    // 双轨 usage：单步时覆盖轨 = 累加轨（M12 契约）
    expect(result.usage).toEqual({ prompt: 1, completion: 1, promptAccumulated: 1, steps: 1 });
  });

  it('M21/D4 工具字典序：schema 序与注册顺序无关（装卸/时序解耦）', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('好') };
    const { ctx } = await boot([s1]);
    // 乱序注册（模拟插件加载时序产物）
    for (const name of ['zulu_tool', 'alpha_tool', 'mid_tool']) {
      ctx.tools.register({ name, description: name, execute: () => ({ ok: true }) });
    }
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('嗨') });
    const names = (s1.calls[0].tools ?? []).map((t) => t.function.name);
    expect(names).toEqual(['alpha_tool', 'mid_tool', 'zulu_tool']);
    // Agent 生效集（request.tools 白名单）同款字典序
    const s2: Script = { calls: [], chunks: () => textChunks('好') };
    // 复用同 boot 的 ctx 再跑一次（scripted 越界复用末套 → 新调用进 s1.calls）
    await ctx.agentLoop.run({
      model: 'mock-1',
      messages: USER('再跑'),
      tools: ['zulu_tool', 'alpha_tool'],
    });
    const names2 = (s1.calls[1].tools ?? []).map((t) => t.function.name);
    expect(names2).toEqual(['alpha_tool', 'zulu_tool']);
    void s2;
  });

  it('两步工具流：tool_calls → ctx.tools 执行 → 结果回填消息 → 最终文本', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'echo', '{"text":"世界"}') };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: (args) => ({ ok: true, output: String(args.text ?? '') }),
    });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('用工具') });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolCalls[0]).toMatchObject({ id: 'c1', name: 'echo' });
    expect(result.steps[0].toolResults[0]).toEqual({ ok: true, output: '世界' });
    expect(result.text).toBe('完成');
    // 第二步收到的消息：assistant(tool_calls) + tool 结果回填
    const msgs = s2.calls[0].messages;
    expect(msgs.find((m) => m.role === 'assistant')).toMatchObject({ tool_calls: [{ id: 'c1' }] });
    expect(msgs.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'c1' });
  });

  it('usage 双轨（M12）：多步 run 覆盖轨=末步上下文、累加轨=各步之和、steps 计数', async () => {
    // 步 1：工具轮（usage prompt=10 cacheHit=4）；步 2：终文本（prompt=20, total=25, cacheHit=6）
    const s1: Script = {
      calls: [],
      chunks: () => [
        ...toolCallChunks('c1', 'echo', '{}').slice(0, 2),
        { delta: '', finish: 'tool_calls', usage: { prompt: 10, completion: 2, cacheHit: 4, cacheMiss: 6 } },
      ],
    };
    const s2: Script = {
      calls: [],
      chunks: () => [
        { delta: '完' },
        { delta: '成', usage: undefined },
        { delta: '', finish: 'stop', usage: { prompt: 20, completion: 3, total: 25, cacheHit: 6, cacheMiss: 14 } },
      ],
    };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true }) });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.usage).toEqual({
      prompt: 20, // 覆盖轨：末步上下文
      completion: 5, // 累加轨
      total: 25, // 覆盖轨
      promptAccumulated: 30, // 累加轨
      totalAccumulated: 25,
      cacheHit: 10,
      cacheMiss: 20,
      steps: 2,
    });
  });

  it('工具清单进入 LLM 请求（ToolDefinition → LlmToolSpec）', async () => {    const s1: Script = { calls: [], chunks: () => textChunks('ok') };
    const { ctx } = await boot([s1]);
    ctx.tools.register({
      name: 'echo',
      description: '回显工具',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: () => ({ ok: true }),
    });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q'), tools: ['echo'] });
    expect(s1.calls[0].tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'echo',
          description: '回显工具',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
    ]);
  });

  it('maxSteps 预算：每步都要工具 → finish max-steps', async () => {
    const { ctx } = await boot([{ calls: [], chunks: () => toolCallChunks('c1', 'echo', '{}') }]);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true }) });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q'), maxSteps: 3 });
    expect(result.finish).toBe('max-steps');
    expect(result.steps).toHaveLength(3);
  });

  it('maxSteps 缺省/0 = receive 模式不限步：靠无工具调用自然收束', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'echo', '{}') };
    const s2: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1, s2]);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true }) });
    // maxSteps: 0 显式不限（trigger/receive 双模式对齐 src）
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q'), maxSteps: 0 });
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(2);
  });

  it('LLM 抛错 → finish error，错误收敛进 result', async () => {
    const { ctx } = await boot([{ calls: [], chunks: () => { throw new Error('模型故障'); } }]);
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.finish).toBe('error');
    expect(result.error).toBe('模型故障');
  });
});

describe('ac-agent-loop 事件', () => {
  it('loop/before-run（waterfall）：变异载体注入 system', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('ok') };
    const { ctx } = await boot([s1]);
    ctx.on('loop/before-run', (call, next) => {
      call.request = { ...call.request, system: '你是海盗' };
      return next();
    });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(s1.calls[0].messages[0]).toEqual({ role: 'system', content: '你是海盗' });
  });

  it('loop/before-run（waterfall）：veto —— LLM 不被调用', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('不应出现') };
    const { ctx } = await boot([s1]);
    ctx.on('loop/before-run', () =>
      Promise.resolve({ steps: [], text: '[被策略拦截]', finish: 'veto' as const, usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } }),
    );
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.finish).toBe('veto');
    expect(result.text).toBe('[被策略拦截]');
    expect(s1.calls).toHaveLength(0);
  });

  it('loop/before-step（waterfall）：本步消息注入临时上下文', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('ok') };
    const { ctx } = await boot([s1]);
    ctx.on('loop/before-step', (call, next) => {
      call.messages = [...call.messages, { role: 'system', content: '[临时]' }];
      return next();
    });
    await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(s1.calls[0].messages.at(-1)).toEqual({ role: 'system', content: '[临时]' });
  });

  it('loop/after-run + loop/after-step（emit）：步级与轮级通知', async () => {
    const { ctx } = await boot([
      { calls: [], chunks: () => toolCallChunks('c1', 'echo', '{}') },
      { calls: [], chunks: () => textChunks('完成') },
    ]);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true }) });
    const steps: LoopStepRecord[] = [];
    const runs: string[] = [];
    ctx.on('loop/after-step', (_agent, step) => steps.push(step));
    ctx.on('loop/after-run', (request, result) => runs.push(`${request.model}:${result.finish}`));
    await ctx.agentLoop.run({ agent: 'a1', model: 'mock-1', messages: USER('q') });
    expect(steps).toHaveLength(2);
    expect(steps[0].toolResults).toEqual([{ ok: true }]);
    expect(runs).toEqual(['mock-1:stop']);
  });

  it('跨域组合：tool/before-execute veto 生效于循环内工具执行', async () => {
    const { ctx } = await boot([
      { calls: [], chunks: () => toolCallChunks('c1', 'echo', '{}') },
      { calls: [], chunks: () => textChunks('好的') },
    ]);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true, output: '不应执行' }) });
    ctx.on('tool/before-execute', (execution, next) =>
      execution.call.name === 'echo' ? { ok: false, error: 'blocked' } : next(),
    );
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.steps[0].toolResults[0]).toEqual({ ok: false, error: 'blocked' });
    expect(result.text).toBe('好的');
  });
});

describe('loop transform 事件（安全审查/脱敏 seam）', () => {
  it('transform-step：脱敏步记录文本，入档与 after-step 通知均为变换后终值', async () => {
    const { ctx } = await boot([{ calls: [], chunks: () => textChunks('密钥是 sk-secret-123') }]);
    ctx.on('loop/transform-step', (payload, next) => {
      payload.step = {
        ...payload.step,
        text: payload.step.text.replace(/sk-\S+/, 'sk-***'),
      };
      return next();
    });
    const notified: string[] = [];
    ctx.on('loop/after-step', (_agent, step) => notified.push(step.text));
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.steps[0].text).toBe('密钥是 sk-***');
    expect(notified).toEqual(['密钥是 sk-***']);
  });

  it('transform-run：改写最终回复（router/调用方拿到变换后终值）', async () => {
    const { ctx } = await boot([{ calls: [], chunks: () => textChunks('原始回复') }]);
    ctx.on('loop/transform-run', (payload, next) => {
      payload.result = { ...payload.result, text: '[已审查] 原始回复' };
      return next();
    });
    const seen: string[] = [];
    ctx.on('loop/after-run', (_req, result) => seen.push(result.text));
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.text).toBe('[已审查] 原始回复');
    expect(seen).toEqual(['[已审查] 原始回复']);
  });

  it('多变换器按注册序叠加（脱敏 + 加前缀）', async () => {
    const { ctx } = await boot([{ calls: [], chunks: () => textChunks('content sk-abc') }]);
    ctx.on('loop/transform-run', (payload, next) => {
      payload.result = { ...payload.result, text: payload.result.text.replace(/sk-\S+/, 'sk-***') };
      return next();
    });
    ctx.on('loop/transform-run', (payload, next) => {
      payload.result = { ...payload.result, text: `[审] ${payload.result.text}` };
      return next();
    });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.text).toBe('[审] content sk-***');
  });

  it('观察者必须 next()：不调 next 即短路替换（文档化行为）', async () => {
    const { ctx } = await boot([{ calls: [], chunks: () => textChunks('真身') }]);
    let secondRan = false;
    ctx.on('loop/transform-run', () => Promise.resolve({
      steps: [],
      text: '[短路替换]',
      finish: 'stop' as const,
      usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    }));
    ctx.on('loop/transform-run', (payload, next) => {
      secondRan = true;
      return next();
    });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.text).toBe('[短路替换]');
    expect(secondRan).toBe(false); // 下游变换器未执行
  });
});
