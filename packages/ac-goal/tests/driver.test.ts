// ============================================================
// ac-goal goal-round 驱动（cr-1050）：轮次记账 meta 贯通 + 等待态门。
// 编排：真 cordis 树（tools/agent-loop/agentStore/jobs/goal）× 假
// conversation（记录投递）——驱动面收束即验，不跑真 LLM。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as jobsRow from 'ac-jobs';
import * as goalRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];
let delivered: Array<{ agent: string; message: string; options: Record<string, unknown> }> = [];

/** 假 conversation：记录 goal-round 投递（deliver 形状——主线/壳两方言叶同构） */
class FakeConversationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'conversation');
  }
  deliver(agent: string, message: string, options: Record<string, unknown> = {}) {
    delivered.push({ agent, message, options });
    return Promise.resolve({ kind: 'run' });
  }
}

/** 假 agentStore：内存 entry 读写（goal 持久化面） */
class FakeAgentStoreService extends Service {
  private entries = new Map<string, unknown>();
  constructor(ctx: Context) {
    super(ctx, 'agentStore');
  }
  readEntry<T>(agentId: string, key: string): T | undefined {
    return this.entries.get(agentId + "///" + key) as T | undefined;
  }
  saveEntry(agentId: string, key: string, value: unknown): void {
    this.entries.set(agentId + "///" + key, value);
  }
}

async function boot(opts: { withJobs?: boolean } = {}) {
  delivered = [];
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<unknown> = [toolsRow, llmRow, loopRow, FakeAgentStoreService, FakeConversationService];
  if (opts.withJobs !== false) rows.push(jobsRow);
  rows.push(goalRow);
  for (const row of rows) {
    const fiber = ctx.plugin(row as never, undefined as never);
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

/** 模拟一次 run 收束（loop/after-run emit——驱动面唯一入口） */
function runSettles(
  ctx: Context,
  finish: 'stop' | 'max-steps' | 'error' | 'interrupted' = 'stop',
  meta?: Record<string, unknown>,
) {
  ctx.emit('loop/after-run',
    { agent: 'a', conversationId: 'user~a', ...(meta ? { meta } : {}) } as never,
    { steps: [], text: '', finish, usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 1 } } as never,
  );
}

/** 手动收束 job（settle 控制器；outcome 可定制——owner 自杀形态用） */
function manualJob(
  ctx: Context,
  ownerAgentId: string,
  conversationId?: string,
  outcome?: { status: 'completed' | 'killed'; detail?: string },
): { settle(): void } {
  let settle!: () => void;
  const done = new Promise<{ status: 'completed' | 'killed'; detail?: string }>((resolve) => {
    settle = () => resolve(outcome ?? { status: 'completed', detail: 'exit code: 0' });
  });
  ctx.jobs.start({
    kind: 'bash',
    label: 'manual',
    ownerAgentId,
    ...(conversationId ? { conversationId } : {}),
    run: () => ({ cancel: () => {}, done }),
  });
  return { settle };
}

describe('ac-goal goal-round 驱动（cr-1050）', () => {
  it('goal-round run 收束 → roundsDone+1 且续投下一轮（meta 轮号贯通）', async () => {
    const { ctx } = await boot();
    const goal = ctx.goals.create('a', 'user~a', '完成目标');
    expect(goal.roundsDone ?? 0).toBe(0);
    runSettles(ctx, 'stop', { 'goal-round': 1 });
    await new Promise((r) => setTimeout(r, 20));
    // 轮次记账 +1（壳侧 meta 贯通后 LoopRunRequest.meta 到达此处）
    expect(ctx.goals.currentOf('a', 'user~a')!.roundsDone).toBe(1);
    // 续投下一轮：Round 2/20（roundsDone+1）
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.message).toContain('Round: 2/20');
    expect(delivered[0]!.options.meta).toEqual({ 'goal-round': 2, origin: 'goal' }); // cr-1238 B5：触发面 origin 声明
  });

  it('非 goal-round run 收束不记账，但 active 目标照常开轮（Round 1）', async () => {
    const { ctx } = await boot();
    ctx.goals.create('a', 'user~a', '完成目标');
    runSettles(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.goals.currentOf('a', 'user~a')!.roundsDone ?? 0).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.message).toContain('Round: 1/20');
  });

  it('等待门：本 Agent 活跃 job 在途 → 暂缓；job settle → 续投下一轮', async () => {
    const { ctx } = await boot();
    ctx.goals.create('a', 'user~a', '完成目标');
    // owner 自杀形态（killedBy='owner'）：wakeup 不投完成通知，本面补位
    const job = manualJob(ctx, 'a', 'user~a', { status: 'killed', detail: 'signal: SIGKILL' });
    // kill 请求走 jobs.kill（记 killedBy='owner'），settle 再兑现 outcome
    const jobList = ctx.jobs.list('a');
    ctx.jobs.kill(jobList[0]!.id, 'a');
    void job;
    runSettles(ctx);
    await new Promise((r) => setTimeout(r, 20));
    // 等待门拦截：job 在途（stopping）不催轮
    expect(delivered).toHaveLength(0);
    job.settle();
    await new Promise((r) => setTimeout(r, 20));
    // job/settled 补位再评估：门开即投
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.message).toContain('Round: 1/20');
  });

  it('等待门只看本 Agent：他 Agent 的 job 不拦本会话开轮', async () => {
    const { ctx } = await boot();
    ctx.goals.create('a', 'user~a', '完成目标');
    manualJob(ctx, 'b', 'user~b'); // 他 Agent 在途
    runSettles(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(1);
  });

  it('jobs 行缺席（未装载）→ 无等待态照常投递（软依赖降级）', async () => {
    const { ctx } = await boot({ withJobs: false });
    ctx.goals.create('a', 'user~a', '完成目标');
    runSettles(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(1);
  });

  it('异常收束 → 自动暂停（回归：finish=error 不投轮）', async () => {
    const { ctx } = await boot();
    ctx.goals.create('a', 'user~a', '完成目标');
    runSettles(ctx, 'error');
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
    const goal = ctx.goals.currentOf('a', 'user~a')!;
    expect(goal.status).toBe('paused');
    expect(goal.autoPausedReason).toContain('异常收束');
  });

  it('轮次上限 → 自动暂停（回归：maxRounds 达到不投轮）', async () => {
    const { ctx } = await boot();
    ctx.goals.create('a', 'user~a', '完成目标', undefined, 1);
    runSettles(ctx, 'stop', { 'goal-round': 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
    expect(ctx.goals.currentOf('a', 'user~a')!.status).toBe('paused');
  });

  it('paused/blocked 目标不驱动（回归）', async () => {
    const { ctx } = await boot();
    ctx.goals.create('a', 'user~a', '完成目标');
    ctx.goals.update('a', 'user~a', { status: 'paused' });
    runSettles(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toHaveLength(0);
  });
});
