// ============================================================
// ac-conversation：串行化门 / steer·next-run placement / next-turn
// 链跑 / MAX_AUTO_WAKES / abort / 群键隔离
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as toolsRow from 'ac-tools';
import * as conversationRow from '../src/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- 手动闸门 mock provider：每次 llm 调用挂起直至 release（测试控制 run 在途） ----
// script[i] = 'tool' → 第 i+1 次调用产出工具调用（驱动 run 继续）；缺省纯文本。

function gatedLlm(script: ('text' | 'tool')[] = []) {
  const calls: LlmChatInput[] = [];
  const resolvers: (() => void)[] = [];
  let counter = 0;
  return {
    calls,
    row() {
      return {
        name: 'mock-gated-llm',
        inject: ['llm'],
        apply(c: Context) {
          c.llm.register(
            'mock',
            () => ({
              stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
                const idx = counter++;
                calls.push(input);
                await new Promise<void>((r) => resolvers.push(r));
                if (script[idx] === 'tool') {
                  yield { delta: '', toolCalls: [{ index: 0, id: `c${idx}`, name: 'noop' }] };
                  yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{}' }] };
                  yield { delta: '', finish: 'tool_calls' };
                } else {
                  yield { delta: `回复${idx + 1}` };
                  yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
                }
              },
            }),
            { models: ['mock-1'] },
          );
        },
      };
    },
    /** 放行当前挂起的全部调用 */
    release() {
      resolvers.splice(0).forEach((r) => r());
    },
    async waitForCall(n = 1) {
      while (calls.length < n) await sleep(5);
    },
    /** 第 i 次调用的消息 content 列表（i 从 0 起） */
    contents(i: number): unknown[] {
      return calls[i].messages.map((x) => x.content);
    },
  };
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(llmRowLike: object) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    llmRowLike as any,
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

function registerNoop(ctx: Context) {
  ctx.tools.register({ name: 'noop', description: '空操作', execute: () => ({ ok: true }) });
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-conversation 串行化门 + steer placement', () => {
  it('busy：第二条注入活跃 run（steered）；会话视图顺序 = 消息1 → 消息2 → 回复', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const steeredEvents: string[] = [];
    ctx.on('conversation/steered', (agentId, message, conversationId, handle) =>
      steeredEvents.push(`${agentId}|${(message as { content: string }).content}|${conversationId}|${handle}`),
    );

    const p1 = ctx.conversation.deliver('a', '第一条');
    await m.waitForCall(1); // run1 在途（step0 挂起中）

    const out2 = await ctx.conversation.deliver('a', '第二条');
    expect(out2).toMatchObject({ kind: 'steered', handle: 'a~user~a' });
    expect(ctx.conversation.isBusy('a')).toBe(true);
    expect(steeredEvents).toEqual(['a|第二条|a~user|a~user~a']); // steer 不经 router → 专属通知事件

    m.release(); // step0 完成 → 末轮 steer 驱动 step1（消费"第二条"）
    await m.waitForCall(2);
    m.release(); // step1 完成 → run1 收束
    const out1 = await p1;
    expect(out1.kind).toBe('run');
    if (out1.kind === 'run') {
      expect(out1.result.finish).toBe('stop');
      expect(out1.result.steps).toHaveLength(2); // 末轮 steer 追加了一步
    }
    expect(m.contents(1)).toContain('第二条');

    // 会话视图顺序验证：第三个 run 的 history = 消息1、消息2、回复
    const p3 = ctx.conversation.deliver('a', '第三条');
    await m.waitForCall(3);
    m.release();
    await p3;
    expect(m.contents(2)).toEqual(['第一条', '第二条', '回复2', '第三条']);
  });

  it('busy：lane next-turn → 入队；当前 run 结束后自动链跑', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    const p1 = ctx.conversation.deliver('a', '首条');
    await m.waitForCall(1);
    const out2 = await ctx.conversation.deliver('a', '排队消息', { lane: 'next-turn' });
    expect(out2).toMatchObject({ kind: 'queued', handle: 'a~user~a' });
    expect(ctx.conversation.stats().queued).toEqual({ 'a~user~a': 1 });

    m.release(); // run1 完成 → 链跑 run2（消费队首）
    await m.waitForCall(2);
    m.release();
    const out1 = await p1;
    expect(out1.kind).toBe('run'); // deliver 返回首个 run 的结果
    expect(m.contents(1)).toEqual(['首条', '回复1', '排队消息']);
    expect(ctx.conversation.stats().queued).toEqual({});
  });

  it('busy：placement next-run → 等空闲后独立 run，返回自己的结果', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    const p1 = ctx.conversation.deliver('a', '慢消息');
    await m.waitForCall(1);
    const p2 = ctx.conversation.deliver('a', '等闲消息', { placement: 'next-run' });

    m.release(); // run1 完成 → p2 的 run 接续（等闲路径观察到门释放）
    await m.waitForCall(2);
    m.release();
    const [out1, out2] = await Promise.all([p1, p2]);
    expect(out1.kind).toBe('run');
    expect(out2.kind).toBe('run');
    expect(m.contents(1)).toEqual(['慢消息', '回复1', '等闲消息']);
  });

  it('busy：placement next-run 超时 → timeout，消息不投递', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const p1 = ctx.conversation.deliver('a', '占住会话');
    await m.waitForCall(1);
    const out = await ctx.conversation.deliver('a', '等不到', {
      placement: 'next-run',
      timeoutMs: 10,
    });
    expect(out).toMatchObject({ kind: 'timeout', handle: 'a~user~a' });
    m.release();
    await p1;
    expect(m.calls).toHaveLength(1); // 超时消息从未进模型
  });
});

describe('next-turn 队列数据面（排队 UI：快照 / 删除 / 插话）', () => {
  it('busy 入队 → queue() 快照（稳定 id + 预览 + 身份）+ queue-changed 权威快照事件', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const snapshots: Array<{ conv: string; items: string[] }> = [];
    ctx.on('conversation/queue-changed', (agentId, conversationId, handle, items) => {
      expect(agentId).toBe('a');
      expect(handle).toBe('a~user~a');
      snapshots.push({ conv: conversationId, items: items.map((x) => x.preview) });
    });

    const p1 = ctx.conversation.deliver('a', '首条');
    await m.waitForCall(1); // run1 在途
    await ctx.conversation.deliver('a', '排队A', { lane: 'next-turn' });
    await ctx.conversation.deliver('a', '排队B', { lane: 'next-turn' });

    const queue = ctx.conversation.queue('a');
    expect(queue).toHaveLength(2);
    expect(queue.map((q) => q.preview)).toEqual(['排队A', '排队B']);
    expect(new Set(queue.map((q) => q.id)).size).toBe(2); // 稳定唯一 id
    expect(queue[0]).toMatchObject({ sender: 'user', source: 'user' });
    expect(typeof queue[0].queuedAt).toBe('number');
    // 每次入队一条权威快照（增量：1 条 → 2 条）
    expect(snapshots.map((s) => s.items)).toEqual([['排队A'], ['排队A', '排队B']]);

    m.release(); // run1 收束 → 链跑 run2（消费排队A）→ 队列快照递减
    await m.waitForCall(2);
    m.release(); // run2 收束 → 链跑 run3（消费排队B）
    await m.waitForCall(3);
    m.release();
    await p1;
    expect(ctx.conversation.queue('a')).toEqual([]);
  });

  it('removeQueued：按 id 删除；已删/不存在 → false', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    const p1 = ctx.conversation.deliver('a', '首条');
    await m.waitForCall(1);
    await ctx.conversation.deliver('a', '排队A', { lane: 'next-turn' });
    await ctx.conversation.deliver('a', '排队B', { lane: 'next-turn' });
    const [first] = ctx.conversation.queue('a');

    expect(ctx.conversation.removeQueued('a', undefined, first.id)).toBe(true);
    expect(ctx.conversation.queue('a').map((q) => q.preview)).toEqual(['排队B']);
    expect(ctx.conversation.removeQueued('a', undefined, first.id)).toBe(false); // 重复删 → not-found
    expect(ctx.conversation.removeQueued('a', undefined, '不存在')).toBe(false);

    m.release(); // run1 收束 → 链跑仅消费剩余的"排队B"
    await m.waitForCall(2);
    m.release();
    await p1;
    expect(m.contents(1)).toContain('排队B');
    expect(m.calls).toHaveLength(2); // "排队A"已删，从未进模型
  });

  it('steerQueued：忙时原子转移到活跃 run 下一步（steered + 入账事件）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const steered: string[] = [];
    ctx.on('conversation/steered', (agentId, message) =>
      steered.push(`${agentId}|${(message as { content: string }).content}`));

    const p1 = ctx.conversation.deliver('a', '首条');
    await m.waitForCall(1);
    await ctx.conversation.deliver('a', '排队消息', { lane: 'next-turn' });
    const [item] = ctx.conversation.queue('a');

    expect(ctx.conversation.steerQueued('a', undefined, item.id)).toBe('steered');
    expect(ctx.conversation.queue('a')).toEqual([]); // 出队
    expect(steered).toEqual(['a|排队消息']); // steer 不经 router → 入账事件

    m.release(); // step0 完成 → 末轮 steer 驱动 step1（消费插话消息）
    await m.waitForCall(2);
    m.release();
    await p1;
    expect(m.contents(1)).toContain('排队消息'); // 注入活跃 run 下一步
    expect(m.calls).toHaveLength(2); // 未额外开 run（对比 next-turn 链跑）
  });

  it('steerQueued：窗口已关（空闲留队）→ 放回原位 requeued，不丢消息', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    // MAX_AUTO_WAKES 预算用尽 → 自主4 留队后会话空闲（唯一空闲留队路径）
    const p1 = ctx.conversation.deliver('a', '主消息', { sender: 'a', source: 'event', conversationId: 'a~a' });
    await m.waitForCall(1);
    for (const text of ['自主1', '自主2', '自主3', '自主4']) {
      await ctx.conversation.deliver('a', text, {
        sender: 'a', source: 'event', conversationId: 'a~a', lane: 'next-turn',
      });
    }
    m.release();
    await m.waitForCall(2); m.release();
    await m.waitForCall(3); m.release();
    await m.waitForCall(4); m.release();
    await p1; // run 链收束（预算用尽），自主4 留队、会话空闲
    expect(ctx.conversation.isBusy('a', 'a~a')).toBe(false);
    const idle = ctx.conversation.queue('a', 'a~a');
    expect(idle.map((q) => q.preview)).toEqual(['自主4']);

    // 空闲时插话 → steer 窗口已关 → 放回原位（DSH：收敛竞态不报失败）
    expect(ctx.conversation.steerQueued('a', 'a~a', idle[0].id)).toBe('requeued');
    expect(ctx.conversation.queue('a', 'a~a').map((q) => q.preview)).toEqual(['自主4']);
    expect(ctx.conversation.steerQueued('a', 'a~a', '不存在')).toBe('not-found');
  });
});

describe('MAX_AUTO_WAKES 防自激（source=event 自动连跑预算）', () => {
  it('自主来源连跑至多 3 次，第 4 条留队；用户消息唤醒后预算重置并消费', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    // 机制触发统一落 Agent 自会话桶 a~a（M19/D2）——同桶才有链跑预算语义
    const p1 = ctx.conversation.deliver('a', '主消息', { sender: 'a', source: 'event', conversationId: 'a~a' });
    await m.waitForCall(1);
    for (const text of ['自主1', '自主2', '自主3', '自主4']) {
      const out = await ctx.conversation.deliver('a', text, {
        sender: 'a',
        source: 'event',
        conversationId: 'a~a',
        lane: 'next-turn',
      });
      expect(out.kind).toBe('queued');
    }

    m.release(); // run1 完成 → 链跑 自主1
    await m.waitForCall(2);
    m.release(); // 自主1 完成 → 链跑 自主2
    await m.waitForCall(3);
    m.release(); // 自主2 完成 → 链跑 自主3
    await m.waitForCall(4);
    m.release(); // 自主3 完成 → 预算上限，自主4 留队，链停
    const out1 = await p1;
    expect(out1.kind).toBe('run');
    expect(m.calls).toHaveLength(4); // 主消息 + 3 次自动连跑
    expect(ctx.conversation.stats().queued).toEqual({ 'a~a~a': 1 }); // 自主4 留队

    // 用户消息（同桶注入，非 event 来源）：预算重置；run 后消费留队的自主4
    const p2 = ctx.conversation.deliver('a', '用户来了', { sender: 'user', conversationId: 'a~a' });
    await m.waitForCall(5);
    m.release();
    await m.waitForCall(6); // 链跑消费"自主4"
    m.release();
    await p2;
    expect(m.calls).toHaveLength(6);
    expect(m.contents(5)).toContain('自主4');
    expect(ctx.conversation.stats().queued).toEqual({});
  });
});

describe('abort 与中断（ADR-2）', () => {
  it('abort → run 以 interrupted 收尾、门释放、链跑停止', async () => {
    const m = gatedLlm(['tool']); // step0 出工具调用 → run 必然尝试第二步
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    registerNoop(ctx);

    const p1 = ctx.conversation.deliver('a', '会被打断');
    await m.waitForCall(1);
    await ctx.conversation.deliver('a', '链跑不应发生', { lane: 'next-turn' });
    expect(ctx.conversation.abort('a')).toBe(1);

    m.release(); // step0 完成 + 工具执行 → 下一步边界发现 signal 已中止
    const out1 = await p1;
    expect(out1.kind).toBe('run');
    if (out1.kind === 'run') {
      expect(out1.result.finish).toBe('interrupted');
      expect(out1.result.interruptReason?.type).toBe('user-abort');
      expect(out1.result.steps).toHaveLength(1); // 已完成步保留
    }
    expect(ctx.conversation.isBusy('a')).toBe(false);
    expect(ctx.conversation.stats().queued).toEqual({ 'a~user~a': 1 }); // 队列保留待自然唤醒

    // 中断后新投递照常（上下文含被打断的消息）
    const p2 = ctx.conversation.deliver('a', '重新开始');
    await m.waitForCall(2);
    m.release();
    await m.waitForCall(3); // p2 的 run 结束 → 自然唤醒消费留队的"链跑不应发生"
    m.release();
    await p2;
    expect(m.contents(1)).toEqual(['会被打断', '重新开始']);
    expect(m.contents(2)).toContain('链跑不应发生'); // 中断只停当次链，队列不丢
    expect(ctx.conversation.stats().queued).toEqual({});
  });
});

describe('群键隔离（handle = conversationId~agent）', () => {
  it('同组两个参与者并发运行；单参与者内串行（steer）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    ctx.agents.register({ id: 'b', model: 'mock-1' });

    const pa = ctx.conversation.deliver('a', '给 a', { conversationId: 'g1' });
    const pb = ctx.conversation.deliver('b', '给 b', { conversationId: 'g1' });
    await m.waitForCall(2); // 两参与者并发在途
    expect(ctx.conversation.listRunning().map((r) => r.handle).sort()).toEqual(['g1~a', 'g1~b']);

    // 同参与者第二条 → steer（串行化）
    const out = await ctx.conversation.deliver('a', '再给 a', { conversationId: 'g1' });
    expect(out).toMatchObject({ kind: 'steered', handle: 'g1~a' });

    m.release(); // 两个参与者的 step0 放行
    m.release();
    let aDone = false;
    void pa.then(() => {
      aDone = true;
    });
    await pb; // b 的 run 已收束
    expect(aDone).toBe(false); // a 还有一步 steer 未消费
    await m.waitForCall(3); // a 因末轮 steer 追加一步
    m.release();
    await pa;
    expect(ctx.conversation.listRunning()).toHaveLength(0);
  });

  it('1v1 与群会话互不干扰（不同 handle 各自独立门与上下文）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });

    const p1v1 = ctx.conversation.deliver('a', '私聊'); // handle = a~user~a（直答对键门）
    await m.waitForCall(1);
    const pGroup = ctx.conversation.deliver('a', '群聊', { conversationId: 'g1' }); // handle = g1~a
    await m.waitForCall(2);
    expect(ctx.conversation.isBusy('a')).toBe(true); // 1v1 忙
    expect(ctx.conversation.isBusy('a', 'g1')).toBe(true); // 群忙
    m.release();
    m.release();
    await Promise.all([p1v1, pGroup]);

    // 1v1 会话视图只含私聊消息
    const p1v1b = ctx.conversation.deliver('a', '私聊2');
    await m.waitForCall(3);
    m.release();
    await p1v1b;
    expect(m.contents(2)).toEqual(['私聊', '回复1', '私聊2']);
  });
});

describe('history 播种与事件面', () => {
  it('首跑 history 播种会话视图；router 事件照常发射（session 可积累）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    const received: string[] = [];
    ctx.on('router/message-received', (agentId, message) =>
      received.push(`${agentId}:${message.content}`),
    );

    const p = ctx.conversation.deliver('a', '新会话', {
      history: [{ role: 'user', content: '旧消息' }, { role: 'assistant', content: '旧回复' }],
    });
    await m.waitForCall(1);
    expect(m.contents(0)).toEqual(['旧消息', '旧回复', '新会话']);
    m.release();
    await p;
    expect(received).toEqual(['a:新会话']);
  });

  it('未知 Agent：错误上抛、门与上下文回滚', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m.row());
    await expect(ctx.conversation.deliver('nope', 'hi')).rejects.toThrow(/unknown agent/);
    expect(ctx.conversation.listRunning()).toHaveLength(0);
  });
});
