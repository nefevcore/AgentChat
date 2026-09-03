// ============================================================
// ac-goal/tests/goal.test.ts —— 长期目标（工具面 + 会话桶 + goal-round 驱动）
//
// · goal 工具 create/get/update 全链（状态机：active→paused→active
//   →blocked→completed；completed 入 history、桶回到无目标态）
// · 桶键 = conversationId ?? agentId（同 Agent 跨桶隔离）
// · 持久化 agentStore entry 'goal'（重启回读）
// · goal-round 驱动：after-run（stop/max-steps）→ deliver 下一轮
//   <goal_round> 消息（sender=桶对端、source='event'、meta 轮号）；
//   goal-round run 收束 → roundsDone 记账；error/interrupted → 自动暂停；
//   轮次上限 → 自动暂停；恢复（status=active）清 autoPausedReason；
//   归档整理 run / settings['goal'].enabled=false 不驱动
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as agentStoreRow from 'ac-agent-store';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as toolsRow from 'ac-tools';
import * as goalRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];
const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-goal-'));
  tmps.push(dir);
  return dir;
}

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      yield { delta: 'ok' };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

/** conversation 桩：只记录 deliver（goal-round 驱动的投递面） */
class StubConversation extends Service {
  delivered: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];

  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }

  async deliver(agentId: string, message: string, options: Record<string, unknown> = {}): Promise<unknown> {
    this.delivered.push({ agentId, message, options });
    return { kind: 'run', result: { finish: 'stop' } };
  }
}

interface BootOpts {
  root?: string;
  withLoop?: boolean;
  withAgents?: boolean;
}

async function boot(opts: BootOpts = {}) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  // 恒用独立数据根（缺省临时目录）——agentStore 落盘隔离，防跨 boot 串桶
  const root = opts.root ?? tmpRoot();
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [agentStoreRow, { root }],
  ];
  if (opts.withAgents) rows.push([agentsRow, undefined]);
  if (opts.withLoop) {
    rows.push([llmRow, undefined]);
    rows.push([{
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
      },
    }, undefined]);
    rows.push([loopRow, undefined]);
  }
  rows.push([goalRow, undefined]);
  for (const [row, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(row as any) : ctx.plugin(row as any, config);
    await fiber;
    fibers.push(fiber);
  }
  const conversation = new StubConversation(ctx);
  booted.push({ ctx, fibers });
  return { ctx, fibers, conversation };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const USER = [{ role: 'user' as const, content: 'hi' }];
const CONV = 'a~user';

/** 手动广播 after-run（驱动器触发口；finish 可配；agent/conversationId 传 null = 显式缺省） */
async function emitAfterRun(
  ctx: Context,
  opts: { meta?: Record<string, unknown>; finish?: string; agent?: string | null; conversationId?: string | null } = {},
): Promise<void> {
  const agent = opts.agent === null ? undefined : (opts.agent ?? 'a');
  const conversationId = opts.conversationId === null ? undefined : (opts.conversationId ?? CONV);
  await ctx.emit('loop/after-run', {
    agent,
    conversationId,
    ...(opts.meta ? { meta: opts.meta } : {}),
  } as never, {
    finish: opts.finish ?? 'stop',
    steps: [],
  } as never);
  await new Promise((r) => setTimeout(r, 0)); // 驱动器 void 异步落定
}

describe('ac-goal 工具面（create/get/update 状态机）', () => {
  it('create → get → 暂停/恢复 → 受阻（缺原因拒绝）→ 达成收口入历史', async () => {
    const { ctx } = await boot();
    const call = { agentId: 'a', conversationId: CONV };

    const created = await ctx.tools.execute({
      name: 'goal', args: { action: 'create', objective: '把检索性能优化到 p99<200ms', max_rounds: 5 }, ...call,
    });
    expect(created.ok).toBe(true);
    const goal = (created.output as { goal: { id: string; status: string; maxRounds?: number } }).goal;
    expect(goal.status).toBe('active');
    expect(goal.maxRounds).toBe(5);

    const got = await ctx.tools.execute({ name: 'goal', args: { action: 'get' }, ...call });
    expect((got.output as { current?: { id: string } }).current?.id).toBe(goal.id);

    const paused = await ctx.tools.execute({ name: 'goal', args: { action: 'update', status: 'paused' }, ...call });
    expect((paused.output as { goal: { status: string } }).goal.status).toBe('paused');

    const resumed = await ctx.tools.execute({ name: 'goal', args: { action: 'update', status: 'active' }, ...call });
    expect((resumed.output as { goal: { status: string } }).goal.status).toBe('active');

    const noReason = await ctx.tools.execute({ name: 'goal', args: { action: 'update', status: 'blocked' }, ...call });
    expect(noReason.ok).toBe(false);
    expect(String(noReason.error)).toContain('blocked_reason');

    const blocked = await ctx.tools.execute({
      name: 'goal', args: { action: 'update', status: 'blocked', blocked_reason: '等压测环境就绪' }, ...call,
    });
    expect((blocked.output as { goal: { status: string; blockedReason?: string } }).goal).toMatchObject({
      status: 'blocked',
      blockedReason: '等压测环境就绪',
    });

    const done = await ctx.tools.execute({ name: 'goal', args: { action: 'update', status: 'completed' }, ...call });
    expect((done.output as { completed: boolean }).completed).toBe(true);

    const after = await ctx.tools.execute({ name: 'goal', args: { action: 'get' }, ...call });
    const snap = after.output as { current?: unknown; history: Array<{ id: string; status: string }> };
    expect(snap.current).toBeUndefined();
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]).toMatchObject({ id: goal.id, status: 'completed', completedAt: expect.any(String) });

    const stale = await ctx.tools.execute({ name: 'goal', args: { action: 'update', status: 'paused' }, ...call });
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain('尚无未完成目标');
  });

  it('同桶重复登记拒绝；max_rounds 非法拒绝；无执行身份拒绝', async () => {
    const { ctx } = await boot();
    const call = { agentId: 'a', conversationId: CONV };
    await ctx.tools.execute({ name: 'goal', args: { action: 'create', objective: '写完周报' }, ...call });

    const dup = await ctx.tools.execute({ name: 'goal', args: { action: 'create', objective: '另一件事' }, ...call });
    expect(dup.ok).toBe(false);
    expect(String(dup.error)).toContain('已有未完成目标');

    const badRounds = await ctx.tools.execute({
      name: 'goal', args: { action: 'create', objective: 'x', max_rounds: 999 }, agentId: 'b', conversationId: 'b~b',
    });
    expect(badRounds.ok).toBe(false);
    expect(String(badRounds.error)).toContain('max_rounds');

    const noId = await ctx.tools.execute({ name: 'goal', args: { action: 'get' } });
    expect(noId.ok).toBe(false);
    expect(String(noId.error)).toContain('执行身份');

    const bad = await ctx.tools.execute({ name: 'goal', args: { action: 'zap' }, ...call });
    expect(bad.ok).toBe(false);
  });

  it('桶隔离：同 Agent 的会话桶与自会话桶互不串扰', async () => {
    const { ctx } = await boot();
    await ctx.tools.execute({
      name: 'goal', args: { action: 'create', objective: '和用户协作的目标' },
      agentId: 'a', conversationId: 'a~user',
    });
    await ctx.tools.execute({
      name: 'goal', args: { action: 'create', objective: '自查自纠目标' },
      agentId: 'a', conversationId: 'a~a',
    });
    const u = await ctx.tools.execute({ name: 'goal', args: { action: 'get' }, agentId: 'a', conversationId: 'a~user' });
    const self = await ctx.tools.execute({ name: 'goal', args: { action: 'get' }, agentId: 'a', conversationId: 'a~a' });
    expect((u.output as { current: { objective: string } }).current.objective).toBe('和用户协作的目标');
    expect((self.output as { current: { objective: string } }).current.objective).toBe('自查自纠目标');
  });
});

describe('ac-goal 持久化（agentStore entry "goal"）', () => {
  it('落盘可读；重启（新组合）回读状态连续（含轮次记账）', async () => {
    const root = tmpRoot();
    const first = await boot({ root });
    first.ctx.goals.create('a', CONV, '迁移旧数据', '已完成一半', 8);
    first.ctx.goals.update('a', CONV, { status: 'paused' });
    const entry = first.ctx.agentStore.readEntry<{ buckets: Record<string, { current?: { objective: string } }> }>('a', 'goal');
    expect(entry?.buckets[CONV]?.current?.objective).toBe('迁移旧数据');
    expect(fs.existsSync(path.join(root, 'agents', 'a', 'goal.json'))).toBe(true);

    const second = await boot({ root });
    const snap = second.ctx.goals.snapshot('a', CONV);
    expect(snap.current).toMatchObject({ objective: '迁移旧数据', status: 'paused', note: '已完成一半', maxRounds: 8 });
  });

  it('conversationId 缺省回落 agentId 桶（timer 自会话等场景同键）', async () => {
    const { ctx } = await boot();
    await ctx.tools.execute({ name: 'goal', args: { action: 'create', objective: '默认桶目标' }, agentId: 'a' });
    expect(ctx.goals.currentOf('a', 'a')?.objective).toBe('默认桶目标');
  });
});

describe('ac-goal goal-round 驱动（after-run → 下一轮 / 自动暂停）', () => {
  it('goalRoundSender：对键取对端 / 自会话取自身 / 非对键取 user（KV 前缀稳定）', () => {
    expect(goalRow.goalRoundSender('admin~user', 'admin')).toBe('user'); // 1v1：对端 = viewer
    expect(goalRow.goalRoundSender('a~user', 'user')).toBe('a'); // 对端判定与 agentId 对称
    expect(goalRow.goalRoundSender('a~a', 'a')).toBe('a'); // 自会话对角线：自身（timer 同款）
    expect(goalRow.goalRoundSender('single-abc', '__standard__')).toBe('user'); // singles：与 webui 用户侧同源
  });

  it('端到端：run 正常收束 → 自动投递第 1 轮（sender=桶对端、source=event、meta 轮号）', async () => {
    const { ctx, conversation } = await boot({ withLoop: true });
    ctx.goals.create('a', CONV, '搭好监控面板', '先选型', 3);

    await ctx.agentLoop.run({ agent: 'a', model: 'mock-1', conversationId: CONV, messages: USER });
    await new Promise((r) => setTimeout(r, 0));

    expect(conversation.delivered).toHaveLength(1);
    const d = conversation.delivered[0]!;
    expect(d.agentId).toBe('a');
    // sender = 桶对端（user）：轮次轮与用户轮的对话信息行一致，system 不翻转
    expect(d.options).toMatchObject({ sender: 'user', source: 'event', conversationId: CONV });
    expect((d.options.meta as Record<string, unknown>)['goal-round']).toBe(1);
    // DSH 单块形态：<goal_round> 标签 + JSON 引用目标（数据安全）+ 轮次 + 常驻指令
    expect(d.message).toContain('<goal_round>');
    expect(d.message).toContain(`Objective: ${JSON.stringify('搭好监控面板')}`);
    expect(d.message).toContain('Round: 1/3');
    expect(d.message).toContain('标记完成');
    expect(d.message).toContain('</goal_round>');
    expect(d.message).not.toContain('上次备注'); // 无备注接力（连续性靠会话历史）
  });

  it('轮次记账：goal-round run 收束 → roundsDone+1 并投递下一轮', async () => {
    const { ctx, conversation } = await boot();
    ctx.goals.create('a', CONV, '写周报', undefined, 3);

    await emitAfterRun(ctx, { meta: { 'goal-round': 1 } });
    expect(ctx.goals.currentOf('a', CONV)?.roundsDone).toBe(1);
    expect(conversation.delivered).toHaveLength(1);
    expect((conversation.delivered[0]!.options.meta as Record<string, unknown>)['goal-round']).toBe(2);
    expect(conversation.delivered[0]!.message).toContain('Round: 2/3');
  });

  it('无目标 / 已暂停 / 已完成：不投递', async () => {
    const { ctx, conversation } = await boot();
    await emitAfterRun(ctx, {}); // 无目标
    ctx.goals.create('a', CONV, '目标一');
    ctx.goals.update('a', CONV, { status: 'paused' });
    await emitAfterRun(ctx, {});
    ctx.goals.update('a', CONV, { status: 'active' });
    ctx.goals.update('a', CONV, { status: 'completed' });
    await emitAfterRun(ctx, {});
    expect(conversation.delivered).toHaveLength(0);
  });

  it('异常收束（error/interrupted）→ 自动暂停（autoPausedReason 落账）；恢复即清除', async () => {
    const { ctx, conversation } = await boot();
    ctx.goals.create('a', CONV, ' unstable 目标');

    await emitAfterRun(ctx, { finish: 'interrupted' });
    const paused = ctx.goals.currentOf('a', CONV);
    expect(paused?.status).toBe('paused');
    expect(paused?.autoPausedReason).toContain('interrupted');
    expect(conversation.delivered).toHaveLength(0);

    ctx.goals.update('a', CONV, { status: 'active' });
    expect(ctx.goals.currentOf('a', CONV)?.autoPausedReason).toBeUndefined();
  });

  it('轮次上限：goal-round 收束达 maxRounds → 自动暂停不投递', async () => {
    const { ctx, conversation } = await boot();
    ctx.goals.create('a', CONV, '一次就好', undefined, 1);
    await emitAfterRun(ctx, { meta: { 'goal-round': 1 } });
    const goal = ctx.goals.currentOf('a', CONV);
    expect(goal?.roundsDone).toBe(1);
    expect(goal?.status).toBe('paused');
    expect(goal?.autoPausedReason).toContain('轮次上限');
    expect(conversation.delivered).toHaveLength(0);
  });

  it('max-steps 正常续轮；归档整理 run 与无桶 run 不驱动', async () => {
    const { ctx, conversation } = await boot();
    ctx.goals.create('a', CONV, '长任务', undefined, 5);
    await emitAfterRun(ctx, { finish: 'max-steps' });
    expect(conversation.delivered).toHaveLength(1); // max-steps = 步预算尽，开新轮续推

    conversation.delivered.length = 0;
    await emitAfterRun(ctx, { meta: { 'archive-review': true } }); // 归档整理 run
    await emitAfterRun(ctx, { agent: null, conversationId: null }); // 子 Agent / loop 直连
    expect(conversation.delivered).toHaveLength(0);
  });

  it("settings['goal'].enabled=false → 不自动开轮（agentGate）", async () => {
    const { ctx, conversation } = await boot({ withAgents: true });
    ctx.agents.register({ id: 'a', model: 'mock-1', settings: { goal: { enabled: false } } });
    ctx.goals.create('a', CONV, '被停用的目标');
    await emitAfterRun(ctx, {});
    expect(conversation.delivered).toHaveLength(0);
  });
});

describe('ac-goal 行回收（注册即归属）', () => {
  it('摘行 fiber → 工具与服务一并消失，驱动器停止（零 dispose 代码）', async () => {
    const { ctx, fibers, conversation } = await boot();
    expect(ctx.tools.has('goal')).toBe(true);
    ctx.goals.create('a', CONV, '目标');
    await fibers[fibers.length - 1]!.dispose();
    expect(ctx.tools.has('goal')).toBe(false);
    expect(ctx.goals).toBeUndefined();
    await ctx.emit('loop/after-run', { agent: 'a', conversationId: CONV } as never, { finish: 'stop', steps: [] } as never);
    expect(conversation.delivered).toHaveLength(0);
  });
});
