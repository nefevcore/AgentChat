// ============================================================
// ac-jobs wakeup：job/settled → conversation.deliver(source:'event')
// 通知回投（cr-992 随迁补齐）。策略锁定：无 owner 跳过 / 发起会话优先 /
// conversation 未装跳过 / sub owner 无会话键跳过 / owner 自杀不通知
// （killedBy 判据）/ digest 窗口聚合。
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as jobsRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
let delivered: Array<{ agent: string; message: string; options: Record<string, unknown> }> = [];

/** 假 conversation：记录投递（软依赖消费面——只需 deliver 形状） */
class FakeConversationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }
  deliver(agent: string, message: string, options: Record<string, unknown> = {}) {
    delivered.push({ agent, message, options });
    return Promise.resolve({ kind: 'run' });
  }
}

/** 假 subagents：get 只认 sub_ 前缀（cr-132 过滤判据） */
class FakeSubagentsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagents');
  }
  get(id: string): { id: string } | undefined {
    return id.startsWith('sub_') ? { id } : undefined;
  }
}

async function boot(opts: { withConversation?: boolean; withSubagents?: boolean } = {}) {
  delivered = [];
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: unknown[] = [
    ...(opts.withConversation === false ? [] : [FakeConversationService]),
    ...(opts.withSubagents ? [FakeSubagentsService] : []),
    jobsRow,
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

/** 立即完成任务 */
function settleNow(ctx: Context, ownerAgentId?: string, conversationId?: string): void {
  ctx.jobs.start({
    kind: 'bash',
    label: 'echo hi',
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    run: () => ({
      cancel: () => {},
      done: Promise.resolve({ status: 'completed' as const, detail: 'exit code: 0' }),
    }),
  });
}

/** 手动收束任务（kill 用例） */
function manualJob(ctx: Context, ownerAgentId?: string): {
  id: string;
  settle: (o: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void;
} {
  let settle!: (o: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void;
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((resolve) => {
    settle = resolve;
  });
  const id = ctx.jobs.start({
    kind: 'bash',
    label: 'manual',
    ...(ownerAgentId ? { ownerAgentId } : {}),
    run: () => ({ cancel: () => {}, done }),
  });
  return { id, settle };
}

describe('ac-jobs 完成通知回投（wakeup）', () => {
  it('有 owner 的任务 settle → deliver(source:event，回退自会话桶)；无 owner 跳过', async () => {
    const { ctx } = await boot();
    settleNow(ctx, 'a');
    settleNow(ctx); // 无主——不唤醒
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ agent: 'a' });
    expect(delivered[0].options).toMatchObject({ sender: 'a', source: 'event', conversationId: 'a~a' });
    expect(delivered[0].message).toContain('[系统通知]');
    expect(delivered[0].message).toContain('完成');
    expect(delivered[0].message).toContain('exit code: 0');
  });

  it('回投发起会话：job.conversationId 优先——通知回发起会话而非 owner 自会话桶', async () => {
    const { ctx } = await boot();
    settleNow(ctx, 'admin', 'admin~user');
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].options).toMatchObject({ conversationId: 'admin~user' });
  });

  it('conversation 未装（行组合可选）→ 静默跳过不炸', async () => {
    const { ctx } = await boot({ withConversation: false });
    expect(() => settleNow(ctx, 'a')).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
  });

  it('子 Agent owner 不唤醒（cr-132）：无会话键的 sub_* job 跳过；显式 conversationId 照常回投', async () => {
    const { ctx } = await boot({ withSubagents: true });
    settleNow(ctx, 'sub_1_a'); // 子 Agent run 内 job（无会话键）——不投
    settleNow(ctx, 'sub_1_a', 'admin~user'); // 显式发起会话——照常回投
    settleNow(ctx, 'a'); // 普通 Agent 照常
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(2);
    expect(delivered.find((d) => d.options.conversationId === 'sub_1_a~sub_1_a')).toBeUndefined();
    expect(delivered.find((d) => d.options.conversationId === 'admin~user')).toBeDefined();
    expect(delivered.find((d) => d.options.conversationId === 'a~a')).toBeDefined();
  });

  it('owner 自杀不通知（cr-218/227）：killedBy 判不依赖终态字面；外部 kill 与 kill 失败照投', async () => {
    const { ctx } = await boot();
    // owner 自杀：settle killed → 不投
    const self = manualJob(ctx, 'a');
    ctx.jobs.kill(self.id, 'a');
    self.settle({ status: 'killed', detail: 'signal: SIGKILL' });
    // 字面陷阱（cr-227）：Windows taskkill → producer 报 completed——killedBy 仍判 owner，不投
    const fake = manualJob(ctx, 'a2');
    ctx.jobs.kill(fake.id, 'a2');
    fake.settle({ status: 'completed', detail: 'exit code: 1' });
    // 外部终止（宿主全权 kill）：照投
    const ext = manualJob(ctx, 'b');
    ctx.jobs.kill(ext.id);
    ext.settle({ status: 'killed', detail: 'signal: SIGKILL' });
    // kill 失败（settle failed）：照投——意外事件不在过滤面
    const fail = manualJob(ctx, 'c');
    ctx.jobs.kill(fail.id, 'c');
    fail.settle({ status: 'failed', detail: 'cancel threw: boom' });
    // 自然完成对照：照投
    settleNow(ctx, 'd');
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered).toHaveLength(3); // b + c + d；a/a2 无投递
    expect(delivered.find((d) => d.agent === 'a')).toBeUndefined();
    expect(delivered.find((d) => d.agent === 'a2')).toBeUndefined();
    expect(delivered.find((d) => d.agent === 'b')?.message).toContain('已终止');
    expect(delivered.find((d) => d.agent === 'c')?.message).toContain('失败');
    expect(delivered.find((d) => d.agent === 'd')?.message).toContain('完成');
  });

  it('卸载 jobs 行 → 订阅与服务面一并回收（订阅即归属）', async () => {
    const { ctx, fibers } = await boot();
    const jobsFiber = fibers.at(-1)!;
    await jobsFiber.dispose();
    // 服务面与事件订阅同随行回收：jobs 不可用，且 settled 监听不再触达投递
    expect(ctx.jobs).toBeUndefined();
    expect(() => ctx.emit('job/settled', {
      id: 'bash-9', kind: 'bash', label: 'x', status: 'completed',
      ownerAgentId: 'a', startedAt: Date.now(), detail: 'exit code: 0',
    } as any)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
  });

  it('合并窗口：同 owner+会话第二条起暂存，窗口收束补投 digest', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = await boot();
      settleNow(ctx, 'a'); // 首条：立即投递
      settleNow(ctx, 'a'); // 后续：暂存
      settleNow(ctx, 'a'); // 暂存
      settleNow(ctx, 'b'); // 不同 owner：独立窗口首条照常投
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(2); // a 首条 + b 首条
      expect(delivered[0].message).toContain('完成');
      await vi.advanceTimersByTimeAsync(5_100);
      expect(delivered).toHaveLength(3); // a 的 digest 补投
      const digest = delivered[2];
      expect(digest.agent).toBe('a');
      expect(digest.options.conversationId).toBe('a~a');
      expect(digest.message).toContain('另有 2 个后台任务收束');
      // digest 后新 settled → 新窗口首条（不丢通知）
      settleNow(ctx, 'a');
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(4);
      expect(delivered[3].message).toContain('[系统通知] 后台任务');
    } finally {
      vi.useRealTimers();
    }
  });

  it('合并窗口按会话分桶：a~b 与 a~a 不互相暂存', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = await boot();
      settleNow(ctx, 'a', 'a~b');
      settleNow(ctx, 'a');
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(2);
      expect(delivered[0].options.conversationId).toBe('a~b');
      expect(delivered[1].options.conversationId).toBe('a~a');
      await vi.advanceTimersByTimeAsync(5_100);
      expect(delivered).toHaveLength(2); // 无暂存 → 无 digest
    } finally {
      vi.useRealTimers();
    }
  });
});
