// ============================================================
// ac-group：成员表 / 单通道投递（busy=steer）/ GroupFeed 锚点增量
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as conversationRow from 'ac-conversation';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as toolsRow from 'ac-tools';
import * as groupRow from '../src/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- 手动闸门 mock provider（同 ac-conversation 测试） ----

function gatedLlm() {
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
                yield { delta: `回复${idx + 1}` };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              },
            }),
            { models: ['mock-1'] },
          );
        },
      };
    },
    release() {
      resolvers.splice(0).forEach((r) => r());
    },
    async waitForCall(n = 1) {
      while (calls.length < n) await sleep(5);
    },
    contents(i: number): unknown[] {
      return calls[i].messages.map((x) => x.content);
    },
  };
}

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(m: ReturnType<typeof gatedLlm>) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    m.row() as any,
    loopRow,
    agentsRow,
    routerRow,
    conversationRow,
    groupRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row);
    await fiber;
    fibers.push(fiber);
  }
  ctx.agents.register({ id: 'a', model: 'mock-1' });
  ctx.agents.register({ id: 'b', model: 'mock-1' });
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

describe('ac-group 成员表', () => {
  it('创建/查询/成员校验（成员须是已注册 Agent）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    expect(() => ctx.group.create({ id: 'g', name: '群', members: ['a', 'ghost'] })).toThrow(
      /未注册/,
    );
    const g = ctx.group.create({ id: 'g', name: '群', members: ['a', 'b'] });
    expect(g.members).toEqual(['a', 'b']);
    expect(() => ctx.group.create({ id: 'g', name: '重复', members: ['a'] })).toThrow(/已存在/);
    expect(ctx.group.get('g')?.name).toBe('群');
    expect(ctx.group.isMember('g', 'a')).toBe(true);
    expect(ctx.group.listForAgent('a').map((x) => x.id)).toEqual(['g']);
  });

  it('join/leave/rename/自动删除 + 事件载荷', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    const events: string[] = [];
    ctx.on('group/created', (g) => events.push(`created:${g.id}`));
    ctx.on('group/member-added', (gid, aid) => events.push(`join:${aid}`));
    ctx.on('group/member-removed', (gid, aid) => events.push(`leave:${aid}`));
    ctx.on('group/renamed', (_gid, name) => events.push(`renamed:${name}`));
    ctx.on('group/deleted', (gid) => events.push(`deleted:${gid}`));

    ctx.group.create({ id: 'g', name: '群', members: ['a'] });
    expect(ctx.group.join('g', 'b')).toBe(true);
    expect(ctx.group.join('g', 'b')).toBe(true); // 幂等
    expect(ctx.group.join('g', 'ghost')).toBe(false);
    expect(ctx.group.rename('g', '新名')).toBe(true);
    expect(ctx.group.leave('g', 'b')).toBe(true);
    expect(ctx.group.leave('g', 'a')).toBe(true); // 清空 → 自动删除
    expect(ctx.group.get('g')).toBeUndefined();
    expect(events).toEqual([
      'created:g',
      'join:b',
      'renamed:新名',
      'leave:b',
      'leave:a',
      'deleted:g',
    ]);
  });
});

describe('ac-group 内容通道（单通道 v3）', () => {
  it('post 校验：未知群抛错；非成员 Agent 抛错；user 始终允许', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '群', members: ['a'] });
    await expect(ctx.group.post('nope', 'user', 'x')).rejects.toThrow(/不存在/);
    await expect(ctx.group.post('g', 'b', 'x')).rejects.toThrow(/不是群.*的成员/);
    const rec = await ctx.group.post('g', 'user', '你好');
    expect(rec.from).toBe('user');
    expect(rec.id).toMatch(/^msg-/);
  });
});

describe('ac-group 投递（经 ac-conversation）', () => {
  it('user 群发：两个 idle 参与者各开新 run，通知携带 <msg> 包装全文', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });

    const sending = ctx.group.send('g', 'user', '大家好', { settle: true });
    await m.waitForCall(2); // 两参与者并发受理
    m.release();
    m.release();
    const result = await sending;
    expect(result.triggered.sort()).toEqual(['a', 'b']);
    expect(result.delivery?.a.kind).toBe('run');
    expect(result.delivery?.b.kind).toBe('run');
    // 信封：conversationId=群 id；hint = <msg> 包装 + 时间行
    const hint = String(m.contents(0).at(-1));
    expect(hint).toContain('<msg from="user" name="user" group="客厅">大家好</msg>');
    expect(hint).toContain('[当前时间]');
  });

  it('busy 参与者 → steer 注入活跃 run；idle 参与者照常新 run', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });

    // a 在【群会话】里忙（handle=g~a；与 1v1 handle=a 是两扇独立的门）
    const pa = ctx.conversation.deliver('a', 'a 在忙群内旧事', { conversationId: 'g' });
    await m.waitForCall(1);

    const sending = ctx.group.send('g', 'user', '群通知', { settle: true });
    // a：群会话 busy → steered（立即受理）；b：idle → 新 run（挂起中）
    await m.waitForCall(2);
    m.release(); // 放行挂起中的两个调用（a 的 step0 + b 的 run）
    const result = await sending; // a 已 steered；b 的 run 已完成
    expect(result.delivery?.a.kind).toBe('steered');
    expect(result.delivery?.b.kind).toBe('run');

    await m.waitForCall(3); // a 因末轮 steer 追加一步（消费"群通知"）
    m.release();
    await pa;
    expect(String(m.contents(2).at(-1))).toContain('群通知');
  });

  it('Agent 发言：其余成员被触发，发送者不触发自己', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });

    const sending = ctx.group.send('g', 'a', '我是 a', { settle: true });
    await m.waitForCall(1); // 只有 b 受理
    m.release();
    const result = await sending;
    expect(result.triggered).toEqual(['b']);
    expect(String(m.contents(0).at(-1))).toContain('<msg from="a"');
    // 会话桶 = 群 id（session 可按 conversationId=g 积累）
    expect(m.calls[0].messages.length).toBeGreaterThan(0);
  });

  it('缺省 fire-and-forget：send 受理即返回，run 后台进行', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a'] });
    const replies: string[] = [];
    ctx.on('router/reply-completed', (agentId) => replies.push(agentId));

    const result = await ctx.group.send('g', 'user', '异步消息'); // 不等待
    expect(result.triggered).toEqual(['a']);
    expect(replies).toEqual([]); // run 尚未收尾
    await m.waitForCall(1);
    m.release();
    await sleep(20);
    expect(replies).toEqual(['a']);
  });
});

describe('GroupFeed（锚点增量）', () => {
  it('currentAnchor + readSince：锚点后增量、peer 包装 / own 原文、无锚点空页、最新锚点空页、index 回退', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    const r1 = await ctx.group.post('g', 'a', '第一条');
    const r2 = await ctx.group.post('g', 'user', '第二条');
    await ctx.group.post('g', 'b', '第三条');

    // 当前流尾锚点
    const tail = await ctx.group.currentAnchor('g');
    expect(tail.messageId).toBeDefined();
    expect(tail.index).toBe(2);

    // 锚点 = 第一条 → 增量 = 第二、三条（viewer=a：a 的 own=第一条不在增量；user/b 是 peer → 包装）
    const page = await ctx.group.readSince('g', { messageId: r1.id }, { viewer: 'a' });
    expect(page.messageIds).toEqual([r2.id, expect.any(String)]);
    expect(page.injected).toContain('<msg from="user"');
    expect(page.injected).toContain('第二条');
    expect(page.injected).toContain('<msg from="b"');
    expect(page.anchor.index).toBe(2);

    // viewer=b：own（第三条）不包装，peer 包装
    const own = await ctx.group.readSince('g', { messageId: r2.id }, { viewer: 'b' });
    expect(own.injected.startsWith('第三条')).toBe(true); // own 原文，无 <msg> 前缀

    // 无锚点 → 空增量（防双注）
    const noAnchor = await ctx.group.readSince('g', undefined, { viewer: 'a' });
    expect(noAnchor.injected).toBe('');
    expect(noAnchor.messageIds).toEqual([]);
    expect(noAnchor.anchor.index).toBe(2); // 空页 = 当前流尾

    // 锚点 = 最新 → 空增量
    const latest = await ctx.group.readSince('g', tail, { viewer: 'a' });
    expect(latest.injected).toBe('');

    // index 回退（无 messageId 的锚点）
    const byIndex = await ctx.group.readSince('g', { index: 0 }, { viewer: 'a' });
    expect(byIndex.messageIds).toHaveLength(2);

    // 空群 → index -1
    ctx.group.create({ id: 'empty', name: '空', members: ['a'] });
    expect(await ctx.group.currentAnchor('empty')).toEqual({ index: -1 });
  });
});
