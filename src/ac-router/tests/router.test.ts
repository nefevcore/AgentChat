import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { Context, type Fiber } from '@agentchat/cordis';
import { ConfigService } from 'ac-config';
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

  it('工具可见面 = 注册面 ∩ 能力面（2026-09-02 反馈 #1）：requiredTags 缺标签的工具不进 LLM 工具清单', async () => {
    const { ctx } = await boot('回复');
    ctx.tools.register({ name: 'plain-tool', description: 'd', execute: () => ({ ok: true }) });
    ctx.tools.register({
      name: 'str_replace_editor', description: 'd',
      requiredTags: ['fs_minimal'], execute: () => ({ ok: true }),
    });
    // 无标签 Agent：门禁工具不可见（此前仅执行时 veto——LLM 看得到还浪费一轮调用）
    ctx.agents.register({ id: 'plain', model: 'mock-1' });
    await ctx.router.send('plain', 'q');
    const plainTools = (captured.at(-1)!.tools ?? []).map((t) => t.function.name);
    expect(plainTools).toContain('plain-tool');
    expect(plainTools).not.toContain('str_replace_editor');
    // tags 命中：可见
    ctx.agents.register({ id: 'tagged', model: 'mock-1', tags: ['fs_minimal'] });
    await ctx.router.send('tagged', 'q');
    const taggedTools = (captured.at(-1)!.tools ?? []).map((t) => t.function.name);
    expect(taggedTools).toContain('str_replace_editor');
    // 覆盖层（settings.security.capabilities 追加）命中：可见
    ctx.agents.register({
      id: 'overlay', model: 'mock-1',
      settings: { security: { capabilities: ['fs_minimal'] } },
    });
    await ctx.router.send('overlay', 'q');
    const overlayTools = (captured.at(-1)!.tools ?? []).map((t) => t.function.name);
    expect(overlayTools).toContain('str_replace_editor');
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

describe('ac-router 模型引用 name@model（P4 边界拆分）', () => {
  /** 双 provider boot：alpha[a-1] / beta[b-1]——跨 provider 断言用 */
  async function bootDual() {
    counter = 0;
    captured.length = 0;
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows = [
      toolsRow,
      llmRow,
      {
        name: 'mock-providers',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register('alpha', textProvider('来自 alpha'), { models: ['a-1'] });
          c.llm.register('beta', textProvider('来自 beta'), { models: ['b-1'] });
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

  it('agent.model 带 @：拆出 provider（跨 provider），model 恒裸名', async () => {
    const { ctx } = await bootDual();
    ctx.agents.register({ id: 'a', model: 'beta@b-1', provider: 'alpha' });
    const run = await ctx.router.send('a', 'q');
    expect(run.text).toBe('来自 beta'); // 路由到了 beta（覆盖 agent.provider=alpha）
    expect(captured[0].provider).toBe('beta');
    expect(captured[0].model).toBe('b-1'); // 裸名——usage/delta 不被 @ 污染
  });

  it('会话级覆盖 options.model 带 @：优先于 agent.model + agent.provider', async () => {
    const { ctx } = await bootDual();
    ctx.agents.register({ id: 'a', model: 'a-1', provider: 'alpha' });
    await ctx.router.send('a', 'q', { model: 'beta@b-1' });
    expect(captured[0].provider).toBe('beta');
    expect(captured[0].model).toBe('b-1');
  });

  it('裸名覆盖：provider 跟随 Agent（旧语义不变）', async () => {
    const { ctx } = await bootDual();
    ctx.agents.register({ id: 'a', model: 'a-1', provider: 'alpha' });
    await ctx.router.send('a', 'q', { model: 'b-1' });
    expect(captured[0].provider).toBe('alpha');
    expect(captured[0].model).toBe('b-1');
  });

  it('左段非已注册 provider 名：整串按裸模型路由（防误伤含 @ 的模型 id）', async () => {
    const { ctx } = await bootDual();
    ctx.agents.register({ id: 'a', model: 'a-1', provider: 'alpha' });
    await ctx.router.send('a', 'q', { model: 'ghost@x-1' });
    expect(captured[0].provider).toBe('alpha');
    expect(captured[0].model).toBe('ghost@x-1');
  });

  it('Agent 未声明 model（「默认」= 存 null）→ 回落默认池连接；provider 随归属连接走', async () => {
    // config llmProviders：默认条目名 = 已注册 provider 名（池条目名即注册名）
    const root = await mkdtemp(join(tmpdir(), 'ac-router-pool-'));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(join(root, 'config.json'), JSON.stringify({
      llmProviders: {
        alpha: { base_url: 'https://alpha.example/v1', defaultModel: 'a-1' },
        beta: { base_url: 'https://beta.example/v1', defaultModel: 'b-1', default: true },
      },
    }));
    const { ctx } = await bootDual();
    void new ConfigService(ctx, { root }); // 直构服务（随 ctx 销毁回收，不入行卸载列）

    // model: null（admin 清除语义）+ agent.provider 指向另一连接 → 默认连接胜出
    ctx.agents.register({ id: 'a', model: null as unknown as string, provider: 'alpha' });
    const run = await ctx.router.send('a', 'q');
    expect(run.text).toBe('来自 beta');
    expect(captured[0].provider).toBe('beta');
    expect(captured[0].model).toBe('b-1');
  });

  it('未声明 model 且无默认连接可回落 → 维持 fail-closed 校验错误', async () => {
    const { ctx } = await bootDual(); // 无 config 服务 → defaultConnection undefined
    ctx.agents.register({ id: 'a', model: null as unknown as string, provider: 'alpha' });
    await expect(ctx.router.send('a', 'q')).rejects.toThrow(/缺少 model 配置/);
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

describe('router/before-deliver（投递边界决策 seam，预留）', () => {
  it('观察：载体携带解析后的信封拓扑（缺省派生先于 waterfall）', async () => {
    const { ctx } = await boot('ok');
    ctx.agents.register({ id: 'helper', model: 'mock-1' });
    const seen: Array<Record<string, unknown>> = [];
    ctx.on('router/before-deliver', async (call, next) => {
      seen.push({ ...call });
      return next();
    });
    await ctx.router.send('helper', 'hi', {
      sender: 'leader',
      source: 'agent',
      conversationId: 'leader~helper',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agentId: 'helper',
      sender: 'leader',
      source: 'agent',
      conversationId: 'leader~helper',
    });
    expect(seen[0].message).toEqual({ role: 'user', content: 'hi' });
    // 直通：finish 正常（无监听器改写时零开销）
    expect(captured).toHaveLength(1);
  });

  it('改写：变异载体后照常投递（message-received 与 loop 信封均用改写值）', async () => {
    const { ctx } = await boot('ok');
    ctx.agents.register({ id: 'helper', model: 'mock-1' });
    const received: Array<Record<string, unknown>> = [];
    ctx.on('router/message-received', (agentId, message, _conv, sender) => {
      received.push({ agentId, message, sender });
    });
    ctx.on('router/before-deliver', async (call, next) => {
      call.sender = 'rewriter';
      call.message = { role: 'user', content: '改写后的内容' };
      return next();
    });
    const run = await ctx.router.send('helper', '原始内容');
    expect(run.finish).toBe('stop');
    expect(received[0]).toMatchObject({
      agentId: 'helper',
      sender: 'rewriter',
      message: { role: 'user', content: '改写后的内容' },
    });
    const msgs = captured[0].messages;
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '改写后的内容' });
  });

  it('veto：不调 next 自返回结果——message-received 不发、loop 不启动', async () => {
    const { ctx } = await boot('ok');
    ctx.agents.register({ id: 'helper', model: 'mock-1' });
    let received = 0;
    ctx.on('router/message-received', () => {
      received += 1;
    });
    ctx.on('router/before-deliver', async () => ({
      steps: [],
      text: '投递被边界拒绝（预留 seam）',
      finish: 'veto',
      usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    }));
    const run = await ctx.router.send('helper', 'hi');
    expect(run.finish).toBe('veto');
    expect(run.text).toBe('投递被边界拒绝（预留 seam）');
    expect(run.steps).toEqual([]);
    expect(received).toBe(0);
    expect(captured).toHaveLength(0); // LLM 未被调用
  });
});
