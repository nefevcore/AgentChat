import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as jobsRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(options?: { maxConcurrentJobsPerOwner?: number }) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const fiber = ctx.plugin(jobsRow as any, options ?? {});
  await fiber;
  fibers.push(fiber);
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

/** 手动任务钩子：done 的 resolve/reject 由测试掌控 */
function manualHooks() {
  let settle!: (outcome: { status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }) => void;
  let fail!: (err: unknown) => void;
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>(
    (resolve, reject) => {
      settle = resolve;
      fail = reject;
    },
  );
  const hooks = {
    cancel: vi.fn(),
    done,
    readOutput: vi.fn(() => 'partial output'),
  };
  return { hooks, settle, fail };
}

describe('ac-jobs 注册表', () => {
  it('start 登记 → running；settle first-wins → job/settled 事件一轮', async () => {
    const { ctx } = await boot();
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    const { hooks, settle } = manualHooks();
    const id = ctx.jobs.start({ kind: 'bash', label: 'echo hi', run: () => hooks });
    expect(id).toBe('bash-1');
    expect(ctx.jobs.get(id).status).toBe('running');
    settle({ status: 'completed', detail: 'exit code: 0' });
    await new Promise((r) => setTimeout(r, 0));
    const job = ctx.jobs.get(id);
    expect(job.status).toBe('completed');
    expect(job.detail).toBe('exit code: 0');
    expect(job.finishedAt).toBeGreaterThan(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: 'bash-1', kind: 'bash', status: 'completed' });
    // first-wins：二次 settle 不再生效
    settle({ status: 'failed', detail: 'late' });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.jobs.get(id).status).toBe('completed');
    expect(settled).toHaveLength(1);
  });

  it('owner 分桶：list/get/kill 跨 owner 抛错；同 owner 可见', async () => {
    const { ctx } = await boot();
    const { hooks: hA, settle: sA } = manualHooks();
    const { hooks: hB } = manualHooks();
    ctx.jobs.start({ kind: 'bash', label: 'a', ownerAgentId: 'agent-a', run: () => hA });
    ctx.jobs.start({ kind: 'bash', label: 'b', ownerAgentId: 'agent-b', run: () => hB });
    expect(ctx.jobs.list('agent-a').map((j) => j.label)).toEqual(['a']);
    expect(ctx.jobs.list().length).toBe(2);
    expect(() => ctx.jobs.get('bash-2', 'agent-a')).toThrow(/属于其他 Agent/);
    sA({ status: 'completed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.jobs.list('agent-a')[0].status).toBe('completed');
  });

  it('conversationId 透传（发起会话键）：start → snapshot/settled 可见；未传缺省', async () => {
    const { ctx } = await boot();
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    const { hooks, settle } = manualHooks();
    ctx.jobs.start({
      kind: 'bash', label: 'bg', ownerAgentId: 'b',
      conversationId: 'a~b', run: () => hooks,
    });
    expect(ctx.jobs.get('bash-1', 'b').conversationId).toBe('a~b');
    ctx.jobs.start({ kind: 'bash', label: 'no-conv', ownerAgentId: 'b', run: () => manualHooks().hooks });
    expect(ctx.jobs.get('bash-2', 'b').conversationId).toBeUndefined();
    settle({ status: 'completed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled[0]).toMatchObject({ id: 'bash-1', conversationId: 'a~b' });
  });

  it('每 owner 活跃上限（默认 8）：超出抛错；终态让位', async () => {
    const { ctx } = await boot({ maxConcurrentJobsPerOwner: 2 });
    const mk = () => manualHooks();
    const a = mk(), b = mk(), c = mk();
    ctx.jobs.start({ kind: 't', label: '1', ownerAgentId: 'a1', run: () => a.hooks });
    ctx.jobs.start({ kind: 't', label: '2', ownerAgentId: 'a1', run: () => b.hooks });
    expect(() => ctx.jobs.start({ kind: 't', label: '3', ownerAgentId: 'a1', run: () => c.hooks })).toThrow(
      /已达上限/,
    );
    a.settle({ status: 'completed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(() => ctx.jobs.start({ kind: 't', label: '3', ownerAgentId: 'a1', run: () => c.hooks })).not.toThrow();
  });

  it('kill：running → stopping + cancel 调用；done 回写 killed；已终态 → already-finished', async () => {
    const { ctx } = await boot();
    const { hooks, settle } = manualHooks();
    const id = ctx.jobs.start({ kind: 'bash', label: 'x', run: () => hooks });
    const res = ctx.jobs.kill(id);
    expect(res.outcome).toBe('cancellation-requested');
    expect(res.job.status).toBe('stopping');
    expect(hooks.cancel).toHaveBeenCalled();
    settle({ status: 'killed', detail: 'signal: SIGKILL' });
    await new Promise((r) => setTimeout(r, 0));
    const res2 = ctx.jobs.kill(id);
    expect(res2.outcome).toBe('already-finished');
    expect(ctx.jobs.get(id).status).toBe('killed');
  });

  it('kill cancel 抛错 → 收敛为 failed；done reject → failed', async () => {
    const { ctx } = await boot();
    const bad = {
      cancel: () => {
        throw new Error('boom');
      },
      done: Promise.resolve({ status: 'completed' as const }),
    };
    const id = ctx.jobs.start({ kind: 't', label: 'bad-cancel', run: () => bad });
    const res = ctx.jobs.kill(id);
    expect(res.outcome).toBe('cancellation-requested');
    expect(ctx.jobs.get(id).status).toBe('failed');
    expect(ctx.jobs.get(id).detail).toContain('cancel threw');
    // done reject 路径
    const rejectHooks = {
      cancel: () => {},
      done: Promise.reject(new Error('producer died')),
    };
    const id2 = ctx.jobs.start({ kind: 't', label: 'bad-done', run: () => rejectHooks });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.jobs.get(id2).status).toBe('failed');
    expect(ctx.jobs.get(id2).detail).toContain('producer done rejected');
  });

  it('read：readOutput 优先；终态兜底 detail；无 readOutput 无 detail → 空串', async () => {
    const { ctx } = await boot();
    const withOutput: import('../src/contract.ts').JobHooks = {
      cancel: () => {},
      done: new Promise(() => {}),
      readOutput: () => 'chunk',
    };
    const id1 = ctx.jobs.start({ kind: 't', label: '1', run: () => withOutput });
    expect(ctx.jobs.read(id1).text).toBe('chunk');
    const done = Promise.resolve({ status: 'completed' as const, detail: 'exit code: 0' });
    const id2 = ctx.jobs.start({ kind: 't', label: '2', run: () => ({ cancel: () => {}, done }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.jobs.read(id2).text).toBe('exit code: 0');
  });

  it('start 入参校验：空 kind / 空 label 抛错', async () => {
    const { ctx } = await boot();
    expect(() => ctx.jobs.start({ kind: '  ', label: 'x', run: () => ({ cancel: () => {}, done: new Promise(() => {}) }) })).toThrow();
    expect(() => ctx.jobs.start({ kind: 't', label: '', run: () => ({ cancel: () => {}, done: new Promise(() => {}) }) })).toThrow();
    expect(() => ctx.jobs.get('nope-1')).toThrow(/未知后台任务/);
  });
});
