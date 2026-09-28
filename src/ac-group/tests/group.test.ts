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
import * as sessionRow from 'ac-session';
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
    sessionRow,
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

  it('setDescription：设定/清空 + 事件载荷（终值 description；undefined = 清空）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    const events: Array<string | undefined> = [];
    ctx.on('group/description-set', (_gid, desc) => events.push(desc));

    ctx.group.create({ id: 'g', name: '群', members: ['a'] });
    expect(ctx.group.setDescription('g', '摸鱼互助会')).toBe(true);
    expect(ctx.group.get('g')?.description).toBe('摸鱼互助会');
    expect(ctx.group.setDescription('g', undefined)).toBe(true); // 清空 = 删键
    expect(ctx.group.get('g')?.description).toBeUndefined();
    expect(ctx.group.setDescription('nope', 'x')).toBe(false); // 未知群
    expect(events).toEqual(['摸鱼互助会', undefined]);
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

  it('membersWithUser：完整参与面含隐式成员 user；members 保持纯 Agent 语义', async () => {
    const { ctx } = await boot(gatedLlm());
    ctx.group.create({ id: 'g', name: '群', members: ['a', 'b'] });
    // user 永不入册但恒在参与面首位；已含（防御路径）不重复
    expect(ctx.group.membersWithUser('g')).toEqual(['user', 'a', 'b']);
    expect(ctx.group.get('g')?.members).toEqual(['a', 'b']);
    expect(ctx.group.membersWithUser('nope')).toEqual([]);
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

    // a 在【群成员流会话】里忙（conversationId=g~a；与 1v1 handle=a 是两扇独立的门）
    const pa = ctx.conversation.deliver('a', 'a 在忙群内旧事', { conversationId: 'g~a' });
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

  it('M26：hint/回放解析显示名（注册表 description）——群里显示"小七"而非裸 id', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.agents.register({ id: 'c', model: 'mock-1', description: '小七' });
    ctx.group.create({ id: 'g3', name: '露台', members: ['a', 'c'] });

    const sending = ctx.group.send('g3', 'c', '我上线啦', { settle: true });
    await m.waitForCall(1);
    m.release();
    await sending;
    expect(String(m.contents(0).at(-1))).toContain('<msg from="c" name="小七" group="露台">我上线啦</msg>');
    // 成员流投影行同款显示名（cr-4：post 扇出的 peer 包装）
    const history = await ctx.session.history('g3~a', { viewer: 'a' });
    expect(history.some((h) => String(h.content).includes('name="小七"'))).toBe(true);
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

describe('群聊行为契约（M26 决策点注入）', () => {
  it('群 run 注入正典契约：历史尾部、触发消息之前（倒数第二位）；词形逐字锚定', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });

    const sending = ctx.group.send('g', 'user', '大家好', { settle: true });
    await m.waitForCall(1);
    m.release();
    await sending;
    const contents = m.contents(0).map(String);
    // 契约 = 触发消息之前（上下文倒数第二区），末位是触发 hint
    expect(contents.at(-2)).toBe(groupRow.GROUP_CONTRACT_TEXT);
    expect(contents.at(-1)).toContain('大家好');
    expect(contents.filter((c) => c === groupRow.GROUP_CONTRACT_TEXT)).toHaveLength(1);
  });

  it('per-Agent 文案覆盖：settings["group"].contractText 非空文本生效（空回落正典）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.agents.register({
      id: 'c',
      model: 'mock-1',
      settings: { group: { contractText: '自定义契约：无事勿扰。' } },
    });
    ctx.group.create({ id: 'g2', name: '书房', members: ['c'] });

    const sending = ctx.group.send('g2', 'user', '喂', { settle: true });
    await m.waitForCall(1);
    m.release();
    await sending;
    const contents = m.contents(0).map(String);
    expect(contents).toContain('自定义契约：无事勿扰。');
    expect(contents).not.toContain(groupRow.GROUP_CONTRACT_TEXT);
  });

  it('1v1（非群桶）run 不注入契约', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    const p = ctx.conversation.deliver('a', '私聊一句');
    await m.waitForCall(1);
    m.release();
    await p;
    expect(m.contents(0).map(String).some((c) => c.includes('保持沉默'))).toBe(false);
  });
});

describe('成员私有转录流（cr-4：post 扇出投影）', () => {
  it('post 扇出：own=assistant 原文 / peer=user <msg> 包装 + 时间行；群本体零双录', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'fanout', name: '客厅', members: ['a', 'b'] });
    await ctx.group.post('fanout', 'a', '我说的话');
    await ctx.group.post('fanout', 'user', '用户的话');

    // a 的成员流：own（a）= assistant 原文；user = peer 包装
    const ha = await ctx.session.history('fanout~a', { viewer: 'a' });
    expect(String(ha[0].content)).toBe('我说的话');
    expect(ha[0].role).toBe('assistant');
    expect(String(ha[1].content)).toContain('<msg from="user"');
    expect(String(ha[1].content)).toContain('用户的话');
    expect(ha[1].role).toBe('user');

    // b 的成员流：a/user 全是 peer 包装
    const hb = await ctx.session.history('fanout~b', { viewer: 'b' });
    expect(String(hb[0].content)).toContain('<msg from="a"');
    expect(hb[0].role).toBe('user');

    // 群本体（shelf 桶）零双录：本体行数 = post 数（无成员流投影行混入）
    const body = await ctx.session.records('fanout');
    expect(body.filter((r) => r.role === 'agent')).toHaveLength(2);
  });

  it('沉默权（M26）：run 终稿落成员流（私有转录），不进群本体', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    ctx.group.create({ id: 'g', name: '客厅', members: ['a', 'b'] });
    const sending = ctx.group.send('g', 'user', '大家好', { settle: true });
    await m.waitForCall(1);
    m.release();
    await sending;
    // a 的成员流有 run 转录（终稿行）
    const recordsA = await ctx.session.records('g~a');
    expect(recordsA.some((r) => r.role === 'agent' && r.content.includes('回复'))).toBe(true);
    // 群本体只有 post 行（无 run 终稿/步级行）
    const body = await ctx.session.records('g');
    expect(body.filter((r) => r.role === 'agent' && r.content.includes('回复'))).toHaveLength(0);
  });

  it('撞形防线：群 id 撞已注册 Agent → 拒；Agent id 撞群 → 拒（双向卡位）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    expect(() => ctx.group.create({ id: 'a', name: '伪装', members: ['b'] })).toThrow(/同名/);
    ctx.group.create({ id: 'gx', name: '群', members: ['a'] });
    expect(() => ctx.agents.register({ id: 'gx', model: 'mock-1' })).toThrow(/同名/);
  });

  it('群 id 禁 ~（规约防线①）', async () => {
    const m = gatedLlm();
    const { ctx } = await boot(m);
    expect(() => ctx.group.create({ id: 'g~x', name: '坏', members: ['a'] })).toThrow(/非法/);
  });
});
