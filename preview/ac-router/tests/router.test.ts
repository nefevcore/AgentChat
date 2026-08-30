import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmMessage, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from '../src/index';
import * as toolsRow from 'ac-tools';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

let counter = 0;

function textProvider(text: string) {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      counter += 1;
      captured.push(input);
      yield { delta: text };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

const captured: LlmChatInput[] = [];

async function boot(text: string) {
  counter = 0;
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', textProvider(text), { models: ['mock-1'] });
      },
    },
    loopRow,
    agentsRow,
    routerRow,
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

describe('ac-router', () => {
  it('send：string 糖衣 → 信封投递（agent 配置进入 loop 请求）→ 返回 run', async () => {
    const { ctx } = await boot('你好，我是助手');
    ctx.agents.register({ id: 'helper', model: 'mock-1', system: '你是助手' });
    const run = await ctx.router.send('helper', '打个招呼');
    expect(run.finish).toBe('stop');
    expect(run.text).toBe('你好，我是助手');
    // 信封 = AgentConfig + 消息列表：system 前置 + user 入列
    expect(captured[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(captured[0].model).toBe('mock-1');
  });

  it('history 选项：调用方提供此前会话（router 零会话状态）', async () => {
    const { ctx } = await boot('第二条回复');
    ctx.agents.register({ id: 'helper', model: 'mock-1', system: 'SYS' });
    // 事件积累 + 回放 = 将来 ac-session 的形态
    const log: LlmMessage[] = [];
    ctx.on('router/message-received', (_id, m) => log.push(m));
    ctx.on('router/reply-completed', (_id, text) => log.push({ role: 'assistant', content: text }));
    await ctx.router.send('helper', '第一句');                        // 第一轮：无历史
    await ctx.router.send('helper', '第二句', { history: [...log] }); // 调用方回放
    const msgs = captured.at(-1)!.messages;
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('双通道事件：message-received 先于 loop，reply-completed 后于 loop', async () => {
    const { ctx } = await boot('回复');
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const order: string[] = [];
    ctx.on('router/message-received', (agentId) => order.push(`received:${agentId}`));
    ctx.on('loop/after-run', () => order.push('after-run'));
    ctx.on('router/reply-completed', (agentId, text) => order.push(`reply:${agentId}:${text}`));
    await ctx.router.send('a', '问题');
    expect(order).toEqual(['received:a', 'after-run', 'reply:a:回复']);
  });

  it('未知 Agent → 抛错，无 loop 调用', async () => {
    const { ctx } = await boot('x');
    await expect(ctx.router.send('ghost', 'hi')).rejects.toThrow(/unknown agent: ghost/);
    expect(counter).toBe(0);
  });

  it('loop veto（软拒绝）→ 回复入账为 veto 文本，事件照常广播', async () => {
    const { ctx } = await boot('x');
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.on('loop/before-run', () =>
      Promise.resolve({ steps: [], text: '[策略拦截]', finish: 'veto' as const, usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 } }),
    );
    const seen: Array<[string, string]> = [];
    ctx.on('router/reply-completed', (agentId, text) => seen.push([agentId, text]));
    const run = await ctx.router.send('a', '问题');
    expect(run.finish).toBe('veto');
    expect(counter).toBe(0); // LLM 未被调用
    expect(seen).toEqual([['a', '[策略拦截]']]);
  });

  it('before-run 监听器抛错 → send 整体 reject（硬拒绝语义），LLM 未被调用', async () => {
    const { ctx } = await boot('x');
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.on('loop/before-run', () => {
      throw new Error('预算不足');
    });
    await expect(ctx.router.send('a', '问题')).rejects.toThrow('预算不足');
    expect(counter).toBe(0);
  });
});

describe('ac-router 信封拓扑（L3）', () => {
  it('sender/source/conversationId 进入信封（缺省 user + 直答对键）', async () => {
    const { ctx } = await boot('回复');
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const seen: string[] = [];
    ctx.on('router/message-received', (agentId, _m, conversationId) =>
      seen.push(`${agentId}:${conversationId}`),
    );
    await ctx.router.send('a', 'q');
    expect(seen).toEqual(['a:a~user']); // M19 缺省对键 = pairKey('user', 'a')
    // 信封字段经 loop 到达请求体
    const req = captured.at(-1)!;
    expect(req.sender).toBeUndefined(); // router 层已并入 run；此处捕获的是 LLM 入参
  });

  it('agent⇄agent 委托：sender=agent 端点 id + 指定 conversationId', async () => {
    const { ctx } = await boot('委托结果');
    ctx.agents.register({ id: 'worker', model: 'mock-1' });
    const seen: Array<[string, string]> = [];
    ctx.on('router/message-received', (agentId, _m, conversationId) => seen.push([agentId, conversationId]));
    await ctx.router.send('worker', '帮我查一下', {
      sender: 'leader',
      source: 'agent',
      conversationId: 'leader~worker',
      history: [{ role: 'user', content: '原始任务' }],
    });
    expect(seen).toEqual([['worker', 'leader~worker']]);
    // 到达 LLM：委托方历史 + 新消息
    const msgs = captured.at(-1)!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user']);
    expect(msgs[0]).toEqual({ role: 'user', content: '原始任务' });
  });

  it('event⇄agent 触发：sender=目标自身（自会话）+ source=event（定时/系统事件入口）', async () => {
    const { ctx } = await boot('自动巡检完成');
    ctx.agents.register({ id: 'watchdog', model: 'mock-1' });
    const senders: string[] = [];
    ctx.on('loop/before-run', (call, next) => {
      senders.push(`${call.request.sender ?? '(none)'}/${call.request.source ?? '(none)'}`);
      return next();
    });
    await ctx.router.send('watchdog', '定时巡检', {
      sender: 'watchdog',
      source: 'event',
      conversationId: 'watchdog~watchdog',
    });
    expect(senders).toEqual(['watchdog/event']);
  });

  it('group：多 agent 共享 conversationId（信封透传组键）', async () => {
    const { ctx } = await boot('组内回复');
    ctx.agents.register({ id: 'g-a', model: 'mock-1' });
    ctx.agents.register({ id: 'g-b', model: 'mock-1' });
    const seen: Array<[string, string]> = [];
    ctx.on('router/message-received', (agentId, _m, conversationId) => seen.push([agentId, conversationId]));
    await ctx.router.send('g-a', '大家好', { conversationId: 'room-1' });
    // 第二个 agent 收到同一会话流（含第一个 agent 的回复）
    await ctx.router.send('g-b', '继续', {
      conversationId: 'room-1',
      history: [{ role: 'assistant', content: '大家好，我是 g-a 的回复' }],
    });
    expect(seen).toEqual([
      ['g-a', 'room-1'],
      ['g-b', 'room-1'],
    ]);
  });
});

describe('ac-router 热插拔', () => {
  it('卸载 agent-loop 行 → 依赖链回滚，router 服务随依赖 fiber 消失', async () => {
    const { ctx, fibers } = await boot('回复');
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    expect(ctx.router).toBeDefined();
    // 行序：tools(0) llm(1) mock-provider(2) loop(3) agents(4) router(5)
    const loopFiber = fibers[3];
    await loopFiber.dispose();
    // 依赖服务消失：router 行（inject agentLoop）被回滚，其提供的服务随之消失
    expect((ctx as any).router).toBeUndefined();
    expect((ctx as any).agentLoop).toBeUndefined();
    expect((ctx as any).agents).toBeDefined(); // 无依赖行不受影响
  });
});
