// ============================================================
// @agentchat/jobs —— JobService 测试（统一任务词汇：start/list/get/kill/read
// + owner 分桶/并发上限/first-wins/onJobDone）
// ============================================================
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { JobService, DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER } from '@agentchat/jobs';

function makeService(): JobService {
  return new JobService(new Context(), { maxConcurrentJobsPerOwner: 4 });
}

/** 手动可控的任务钩子（done 由测试 resolve） */
function controllable() {
  let resolveDone!: (o: { status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }) => void;
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>((r) => { resolveDone = r; });
  const cancelled: string[] = [];
  return {
    done, cancelled,
    hooks: () => ({ cancel: (reason?: string) => { cancelled.push(reason ?? ''); }, done }),
    settle: (o: { status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }) => resolveDone(o),
  };
}

describe('JobService', () => {
  it('start 分配不透明 id（<kind>-N）并登记 running', () => {
    const svc = makeService();
    const c = controllable();
    const id = svc.start({ kind: 'bash', label: 'echo hi', ownerAgentId: 'a', meta: { pid: 1 }, run: c.hooks });
    expect(id).toBe('bash-1');
    expect(svc.get(id, 'a').status).toBe('running');
    expect(svc.get(id, 'a').meta?.pid).toBe(1);
    c.settle({ status: 'completed', detail: 'exit code: 0' });
  });

  it('list 按 owner 分桶隔离', () => {
    const svc = makeService();
    const c1 = controllable();
    const c2 = controllable();
    svc.start({ kind: 'bash', label: 'x', ownerAgentId: 'a', run: c1.hooks });
    svc.start({ kind: 'subagent', label: 'y', ownerAgentId: 'b', run: c2.hooks });
    expect(svc.list('a').map(j => j.id)).toEqual(['bash-1']);
    expect(svc.list('b').map(j => j.id)).toEqual(['subagent-1']);
    expect(svc.list().length).toBe(2);
    c1.settle({ status: 'killed' });
    c2.settle({ status: 'completed' });
  });

  it('get/kill/read 跨 owner 被拒', () => {
    const svc = makeService();
    const c = controllable();
    const id = svc.start({ kind: 'bash', label: 'x', ownerAgentId: 'a', run: c.hooks });
    expect(() => svc.get(id, 'b')).toThrow(/无权|属于其他 Agent/);
    expect(() => svc.kill(id, 'b')).toThrow(/无权|属于其他 Agent/);
    expect(() => svc.read(id, 'b')).toThrow(/无权|属于其他 Agent/);
    expect(() => svc.get('nonexistent-1', 'a')).toThrow(/未知后台任务/);
    c.settle({ status: 'killed' });
  });

  it('kill → stopping → done 回写 killed（first-wins）', async () => {
    const svc = makeService();
    const c = controllable();
    const id = svc.start({ kind: 'bash', label: 'x', ownerAgentId: 'a', run: c.hooks });
    expect(svc.kill(id, 'a').outcome).toBe('cancellation-requested');
    expect(svc.get(id, 'a').status).toBe('stopping');
    expect(c.cancelled.length).toBe(1);
    c.settle({ status: 'killed', detail: 'killed before exit' });
    await c.done;
    const job = svc.get(id, 'a');
    expect(job.status).toBe('killed');
    expect(job.detail).toBe('killed before exit');
    // 再 settle 一次被忽略（first-wins）
    c.settle({ status: 'completed' });
    expect(svc.get(id, 'a').status).toBe('killed');
  });

  it('kill 已终态返回 already-finished', async () => {
    const svc = makeService();
    const c = controllable();
    const id = svc.start({ kind: 'bash', label: 'x', ownerAgentId: 'a', run: c.hooks });
    c.settle({ status: 'completed', detail: 'exit code: 0' });
    await c.done;
    expect(svc.kill(id, 'a').outcome).toBe('already-finished');
  });

  it('每 owner 活跃任务数受上限约束（超限抛错）', () => {
    const svc = new JobService(new Context()); // 默认上限 = DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER
    const cs = Array.from({ length: DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER }, () => controllable());
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER; i++) {
      svc.start({ kind: 'bash', label: `x${i}`, ownerAgentId: 'a', run: cs[i].hooks });
    }
    expect(() => svc.start({ kind: 'bash', label: 'over', ownerAgentId: 'a', run: controllable().hooks }))
      .toThrow(/上限/);
    for (const c of cs) c.settle({ status: 'killed' });
  });

  it('read：readOutput 优先，兜底终态 detail；onJobDone 完成时触发一轮', async () => {
    const svc = makeService();
    const doneEvents: string[] = [];
    svc.onJobDone((job) => doneEvents.push(`${job.id}:${job.status}`));

    // subagent 风格：readOutput 返回结果
    const c1 = controllable();
    const id1 = svc.start({ kind: 'subagent', label: 't', ownerAgentId: 'a', run: () => ({ ...c1.hooks(), readOutput: () => 'final report' }) });
    expect(svc.read(id1, 'a').text).toBe('final report');
    c1.settle({ status: 'completed', detail: 'exit ok' });
    await c1.done;

    // bash 风格：无 readOutput → 兜底 detail
    const c2 = controllable();
    const id2 = svc.start({ kind: 'bash', label: 'x', ownerAgentId: 'a', run: c2.hooks });
    c2.settle({ status: 'completed', detail: 'exit code: 0' });
    await c2.done;
    expect(svc.read(id2, 'a').text).toBe('exit code: 0');

    expect(doneEvents).toEqual(['subagent-1:completed', 'bash-1:completed']);
  });
});
