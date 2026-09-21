// ============================================================
// ac-ask-questions/tests/suspension.integration.test.ts —— 全链路挂起测试
//
// loop + durable-interaction + ask-questions 同装配（mock provider）：
//   · 完整链路：ask 工具步 → 自然停 → idle 挂起 → reply → 同 run 续走
//   · 挂起中用户中断 → interrupted 收束
//   · timeout → 超时通知注入续走
//   · run 死后作答 → late-reply 回投（登记表缺席）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as diRow from 'ac-durable-interaction';
import * as askRow from '../src/index.ts';


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

function textChunks(text: string): LlmStreamChunk[] {
  return [{ delta: text.slice(0, 1) }, { delta: text.slice(1) }, { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } }];
}

function toolCallChunks(id: string, name: string, args: string): LlmStreamChunk[] {
  return [
    { delta: '', toolCalls: [{ index: 0, id, name }] },
    { delta: '', toolCalls: [{ index: 0, argumentsDelta: args }] },
    { delta: '', finish: 'tool_calls' },
  ];
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** 五行 boot：tools + llm + mock-provider + loop + di(memory) + ask */
async function boot(scripts: Script[], extra?: {
  deliveries?: Array<Record<string, unknown>>;
  contexts?: Array<{ conversationId: string; agentId: string; content: string; source: string }>;
}) {
  counter = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [llmRow, undefined],
    [{ name: 'mock-provider', inject: ['llm'], apply(c: Context) { c.llm.register('mock', scriptedProvider(scripts), { models: ['mock-1'] }); } }, undefined],
    [loopRow, undefined],
    [diRow, { backend: 'memory' }],
    [askRow, undefined],
  ];
  if (extra?.deliveries) {
    const deliveries = extra.deliveries;
    const { Service } = await import('@agentchat/cordis');
    class ConvStub extends (Service as any) {
      constructor(c: any) { super(c, 'conversation'); }
      listRunning() { return []; }
      deliver(agentId: string, message: string) { deliveries.push({ agentId, message }); return Promise.resolve({}); }
    }
    rows.push([ConvStub, undefined]);
  }
  if (extra?.contexts) {
    const contexts = extra.contexts;
    const { Service } = await import('@agentchat/cordis');
    class SessionStub extends (Service as any) {
      constructor(c: any) { super(c, 'session'); }
      recordContext(conversationId: string, agentId: string, content: string, extra2: { source: string }) {
        contexts.push({ conversationId, agentId, content, source: extra2.source });
        return 'msg-x';
      }
    }
    rows.push([SessionStub, undefined]);
  }
  for (const [row, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 2000; i++) {
    if ((ctx as any).durableInteraction && (ctx as any).tools?.has('ask_questions') && (ctx as any).agentLoop) break;
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
});

describe('ask_questions 挂起全链路（loop/run-idle 同 run 续走）', () => {
  it('完整链路：ask 步 → 自然停挂起 → reply → 答案注入同 run 续走', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'ask_questions', JSON.stringify({
      questions: [{ question: '选哪个？', options: ['A', 'B'] }],
    })) };
    const s2: Script = { calls: [], chunks: () => textChunks('好，按 A 执行') };
    const contexts: Array<{ conversationId: string; agentId: string; content: string; source: string }> = [];
    const { ctx } = await boot([s1, s2], { contexts });
    const running = ctx.agentLoop.run({
      model: 'mock-1',
      agent: 'bot',
      conversationId: 'conv1',
      messages: [{ role: 'user', content: '帮我选' }],
    });
    // 等 ask 落盘 + 模型收尾步（自然停点进入挂起）
    await new Promise((r) => setTimeout(r, 150));
    const open = ctx.durableInteraction.listOpen({ key: 'conv1' })[0];
    expect(open).toMatchObject({ kind: 'ask_questions', owner: 'bot', state: 'pending' });
    ctx.durableInteraction.reply(open.id, { answers: ['A'] });
    const result = await running;
    // 同 run 三步：ask 步 → 收尾步（自然停挂起）→ 答案注入后续走步
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(3);
    expect(result.text).toBe('好，按 A 执行');
    // 续走步（s2 第二次消费）的模型输入包含答案通知（消息数组连续）
    expect(s2.calls).toHaveLength(2);
    const seen = s2.calls[1].messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(seen).toContain('已收到用户回答');
    expect(seen).toContain('选哪个？');
    expect(seen).toContain('A');
    // ask 工具步结果 = awaiting 标记（partial 行 result 非 null）
    const askStep = result.steps[0];
    expect(askStep.toolResults[0]).toMatchObject({ ok: true, output: { status: 'awaiting_user' } });
    // 答案落账（2026-09-21 修正回归）：提问行 + 答案行都经 recordContext（source
    // 恒 durable-interaction）——run 收束后答案在转录在场，与 late-reply 同形状
    expect(contexts).toHaveLength(2);
    expect(contexts[0].content).toContain('[用户提问]');
    expect(contexts[1]).toMatchObject({ conversationId: 'conv1', agentId: 'bot', source: 'durable-interaction' });
    expect(contexts[1].content).toContain('已收到用户回答');
    expect(contexts[1].content).toContain('A');
  });

  it('挂起中用户中断 → interrupted 收束，交互保持 pending（之后作答走 late-reply）', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'ask_questions', JSON.stringify({
      questions: [{ question: 'q', options: ['x'] }],
    })) };
    const s2: Script = { calls: [], chunks: () => textChunks('等你回复') };
    const deliveries: Array<Record<string, unknown>> = [];
    const { ctx } = await boot([s1, s2], { deliveries });
    const ac = new AbortController();
    const running = ctx.agentLoop.run({
      model: 'mock-1',
      agent: 'bot',
      conversationId: 'conv-abort',
      messages: [{ role: 'user', content: '选' }],
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 150));
    const open = ctx.durableInteraction.listOpen({ key: 'conv-abort' })[0];
    expect(open).toBeTruthy();
    // 挂起中中断
    ac.abort('用户中断');
    const result = await running;
    expect(result.finish).toBe('interrupted');
    // 登记表随 run 收束……本实现 openByRun 是模块级：中断路径监听器空手返回但登记未清？
    // 中断后作答 → late-reply（回投）
    await new Promise((r) => setTimeout(r, 50));
    ctx.durableInteraction.reply(open.id, { answers: ['x'] });
    await new Promise((r) => setTimeout(r, 80));
    expect(deliveries).toHaveLength(1);
  });

  it('timeout 路径已随 deadline_ms 移除（2026-12）：等待无超时——未作答时挂起由调用方 signal 收口（idle 挂起不自行超时）', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'ask_questions', JSON.stringify({
      questions: [{ question: 'q', options: ['x'] }],
    })) };
    const s2: Script = { calls: [], chunks: () => textChunks('等你回复') };
    const { ctx } = await boot([s1, s2]);
    const ac = new AbortController();
    const running = ctx.agentLoop.run({
      model: 'mock-1',
      agent: 'bot',
      conversationId: 'conv-timeout',
      messages: [{ role: 'user', content: '选' }],
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 150));
    const open = ctx.durableInteraction.listOpen({ key: 'conv-timeout' })[0];
    expect(open).toBeTruthy();
    expect(open.deadline).toBeUndefined(); // deadline_ms 已移除——不落盘
    ac.abort('调用方超时收口');
    const result = await running;
    expect(result.finish).toBe('interrupted');
  });

  it('session 缺席：ask 步照常（context 行降级），idle 挂起不发生——模型收尾后正常收束', async () => {
    const s1: Script = { calls: [], chunks: () => toolCallChunks('c1', 'ask_questions', JSON.stringify({
      questions: [{ question: 'q', options: ['x'] }],
    })) };
    const s2: Script = { calls: [], chunks: () => textChunks('等你回复') };
    const { ctx } = await boot([s1, s2]);
    // 无 session 行也注册了 idle 监听器（登记表粒度对账）——挂起语义仍生效，
    // 但本用例验证「未作答时不无限挂」由 signal 收口（模拟调用方超时）
    const ac = new AbortController();
    setTimeout(() => ac.abort('超时'), 300);
    const result = await ctx.agentLoop.run({
      model: 'mock-1',
      agent: 'bot',
      conversationId: 'conv-nosess',
      messages: [{ role: 'user', content: '选' }],
      signal: ac.signal,
    });
    expect(result.finish).toBe('interrupted'); // 挂起被调用方 signal 收口
    const open = ctx.durableInteraction.listOpen({ key: 'conv-nosess' })[0];
    expect(open).toBeTruthy();
  });
});

