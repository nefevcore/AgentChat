// ============================================================
// ac-agent-loop/tests/run-idle.test.ts —— loop/run-idle 自然停点拦截
//
// 2026-02 ask 挂起重构的 loop 侧契约测试：
//   · idle 注入续跑：监听器返回材料 → 同 run 续步（消息数组连续）
//   · 无监听恒等：不注册监听器 → 收束行为与旧版一致
//   · 挂起中中止：监听器 await 期间 abort → 空手返回 → interrupted 收束
//   · 预算上限绕行：maxSteps 用尽的终文本轮 idle 注入照常续走
//   · 注入位置：尾部（停步文本先补入工作数组后追加——2026-09-21 修正，
//     头部 splice 使 provider 前缀缓存断裂、注入材料先于用户原始消息）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmMessage, LlmStreamChunk } from 'ac-llm';
import * as llmRow from 'ac-llm';
import * as loopRow from '../src/index.ts';
import * as toolsRow from 'ac-tools';

// ---- 脚手架（与 loop.test.ts 同款：脚本化 provider，第 n 次调用出第 n 套片） ----

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

function textChunks(text: string, usage: { prompt: number; completion: number } = { prompt: 1, completion: 1 }): LlmStreamChunk[] {
  return [{ delta: text.slice(0, 1) }, { delta: text.slice(1) }, { delta: '', finish: 'stop', usage }];
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

describe('loop/run-idle 自然停点拦截', () => {
  it('无监听恒等：不注册 idle 监听器的自然停，行为与旧版一致', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('完成') };
    const { ctx } = await boot([s1]);
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(1);
    expect(result.text).toBe('完成');
  });

  it('idle 注入续跑：监听器返回答案消息 → 同 run 续步消费', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('我先收尾，等你回复') };
    const s2: Script = { calls: [], chunks: () => textChunks('收到答案，继续') };
    const { ctx } = await boot([s1, s2]);
    let injectedOnce = false; // 一次性注入（真实 ask 监听器形态：答案注入后不再有新材料）
    ctx.on('loop/run-idle', async (_call, next) => {
      const rest = await next();
      if (injectedOnce) return rest;
      injectedOnce = true;
      return [{ role: 'user', content: '[系统通知] 用户回答：选 A' } as LlmMessage, ...rest];
    }, { description: '测试注入' });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    // 两轮 LLM：自然停被接住 → 注入 → 续步
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(2);
    expect(result.text).toBe('收到答案，继续');
    // 续步模型可见注入材料（消息数组连续——同 run）
    const seen = s2.calls[0].messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(seen.some((c) => c.includes('用户回答：选 A'))).toBe(true);
  });

  it('注入位置：尾部（停步文本补入后追加），已缓存前缀保持稳定', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('终文本') };
    const s2: Script = { calls: [], chunks: () => textChunks('续') };
    const { ctx } = await boot([s1, s2]);
    let injectedOnce = false;
    ctx.on('loop/run-idle', async (_call, next) => {
      const rest = await next();
      if (injectedOnce) return rest;
      injectedOnce = true;
      return [...rest, { role: 'user', content: '注入材料' } as LlmMessage];
    }, { description: '测试注入' });
    await ctx.agentLoop.run({
      model: 'mock-1',
      system: '系统提示词',
      messages: USER('q'),
    });
    // 续走请求的完整消息序：system → 原始 user → 停步 assistant → 注入 user。
    // （快照对比：脚手架保存的 input.messages 是工作数组引用——loop 会向其
    // push，引用历史同步变异，不能跨 calls 对比数组本身）
    const seen = s2.calls[0].messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : '']);
    expect(seen).toEqual([
      ['system', '系统提示词'],
      ['user', 'q'],
      ['assistant', '终文本'],
      ['user', '注入材料'],
    ]);
  });

  it('挂起中中止：监听器 await 期间 abort → 空手返回 → interrupted 收束', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('我先收尾') };
    const { ctx } = await boot([s1]);
    const ac = new AbortController();
    ctx.on('loop/run-idle', async (call, next) => {
      // 监听器挂起模拟：轮询等待 signal（ask 监听器的真实形态）
      while (!call.request.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return next(); // 中止 → 空手
    }, { description: '测试挂起' });
    const running = ctx.agentLoop.run({ model: 'mock-1', messages: USER('q'), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort('用户中断');
    const result = await running;
    expect(result.finish).toBe('interrupted');
    expect(result.interruptReason?.type).toBe('user-abort');
  });

  it('预算上限绕行：maxSteps=1 用尽的终文本轮，idle 注入照常续走', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('预算内收尾，等回答') };
    const s2: Script = { calls: [], chunks: () => textChunks('继续处理') };
    const { ctx } = await boot([s1, s2]);
    let injectedOnce = false;
    ctx.on('loop/run-idle', async (_call, next) => {
      const rest = await next();
      if (injectedOnce) return rest;
      injectedOnce = true;
      return [{ role: 'user', content: '答案' } as LlmMessage, ...rest];
    }, { description: '测试注入' });
    const result = await ctx.agentLoop.run({
      model: 'mock-1',
      messages: USER('q'),
      maxSteps: 1,
    });
    // 续走步不占预算：2 步且非 max-steps
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(2);
  });

  it('注入后仍自然停：第二次 idle 空手 → 收束（不无限续走）', async () => {
    const s1: Script = { calls: [], chunks: () => textChunks('第一轮') };
    const s2: Script = { calls: [], chunks: () => textChunks('第二轮') };
    const { ctx } = await boot([s1, s2]);
    let fired = 0;
    ctx.on('loop/run-idle', async (_call, next) => {
      const rest = await next();
      fired++;
      // 第一次注入一次，之后空手
      if (fired === 1) return [{ role: 'user', content: '材料' } as LlmMessage, ...rest];
      return rest;
    }, { description: '测试一次性注入' });
    const result = await ctx.agentLoop.run({ model: 'mock-1', messages: USER('q') });
    expect(result.finish).toBe('stop');
    expect(result.steps).toHaveLength(2);
    expect(fired).toBe(2);
  });
});
