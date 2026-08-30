// ============================================================
// @agentchat/shell —— job 工具测试（经 ctx.jobs：id/owner 分桶/状态 + list/kill/logs）
// ============================================================
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import { JobService } from '@agentchat/jobs';
import { makeJobTool } from '@agentchat/shell';
import type { AgentConfig } from '@agentchat/agent-config';
import type { JobHooks } from '@agentchat/jobs';

const config = { agent_id: 't', name: 't' } as AgentConfig;

/** 登记一个 bash 风格任务（meta 带 pid/logFile；cancel 不自动 settle，done 由测试显式 resolve） */
function startFixture(svc: JobService, ownerAgentId: string, pid: number, logFile = 'C:/tmp/agentchat-bash-test.log'): { id: string; settle: () => void } {
  let resolveDone!: (o: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void;
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((r) => { resolveDone = r; });
  const id = svc.start({
    kind: 'bash', label: 'echo hi', ownerAgentId,
    meta: { pid, command: 'echo hi', cwd: '/tmp', logFile },
    run: () => ({ cancel: () => { /* 真实 kill 是异步的：进程死后 close 才 settle */ }, done }),
  });
  return { id, settle: () => resolveDone({ status: 'completed', detail: 'exit code: 0' }) };
}

describe('job 工具（经 ctx.jobs）', () => {
  it('list：返回本 Agent 任务（id/kind/状态/存活/日志大小字段）', async () => {
    const svc = new JobService(new Context());
    const tool = makeJobTool(config, svc);
    const { id } = startFixture(svc, 't', 900101);
    const res = JSON.parse(await tool.execute({ action: 'list' } as any) as string);
    expect(res.status).toBe('ok');
    const entry = res.data.jobs.find((j: any) => j.id === id);
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('bash');
    expect(entry.command).toBe('echo hi');
    expect(entry.status).toBe('running');
    expect(typeof entry.alive).toBe('boolean');
    expect(typeof entry.log_size).toBe('number');
  });

  it('list/kill：跨 owner 隔离（看不到/杀不了别人的任务）', async () => {
    const svc = new JobService(new Context());
    const tool = makeJobTool(config, svc);
    const other = startFixture(svc, 'other', 900102);
    const res = JSON.parse(await tool.execute({ action: 'list' } as any) as string);
    expect(res.data.jobs.some((j: any) => j.id === other.id)).toBe(false);
    const killRes = JSON.parse(await tool.execute({ action: 'kill', job_id: other.id } as any) as string);
    expect(killRes.status).toBe('error');
    other.settle();
  });

  it('kill：缺 job_id / 未知 id 报错；有效 id → cancellation-requested 后 settle killed', async () => {
    const svc = new JobService(new Context());
    const tool = makeJobTool(config, svc);
    const missing = JSON.parse(await tool.execute({ action: 'kill' } as any) as string);
    expect(missing.status).toBe('error');
    const unknown = JSON.parse(await tool.execute({ action: 'kill', job_id: 'bash-999' } as any) as string);
    expect(unknown.status).toBe('error');

    const { id, settle } = startFixture(svc, 't', 900103);
    const ok = JSON.parse(await tool.execute({ action: 'kill', job_id: id } as any) as string);
    expect(ok.status).toBe('ok');
    expect(ok.data.outcome).toBe('cancellation-requested');
    expect(svc.get(id, 't').status).toBe('stopping');
    settle();
    await Promise.resolve(); // 等 done.then(settle) 微任务回写
    expect(svc.get(id, 't').status).toBe('completed'); // first-wins：stopping → done 回写终态
  });

  it('logs：bash 任务读日志尾部；subagent 任务读 readOutput 结果', async () => {
    const svc = new JobService(new Context());
    const tool = makeJobTool(config, svc);

    // bash：meta.logFile 存在（无 readOutput）→ 读文件尾
    const { id } = startFixture(svc, 't', 900104, 'C:/tmp/nonexistent-agentchat-bash.log');
    const bashLogs = JSON.parse(await tool.execute({ action: 'logs', job_id: id } as any) as string);
    expect(bashLogs.status).toBe('ok');
    expect(bashLogs.data.job_id).toBe(id);

    // subagent：有 readOutput → 返回最终结果
    let resolveSub!: (o: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void;
    const subDone = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((r) => { resolveSub = r; });
    const subId = svc.start({
      kind: 'subagent', label: '任务', ownerAgentId: 't',
      run: () => ({ cancel: () => { resolveSub({ status: 'killed', detail: 'killed' }); }, done: subDone, readOutput: () => 'final report' } as JobHooks),
    });
    const subLogs = JSON.parse(await tool.execute({ action: 'logs', job_id: subId } as any) as string);
    expect(subLogs.status).toBe('ok');
    expect(subLogs.data.content).toBe('final report');
    resolveSub({ status: 'completed', detail: 'exit ok' });
  });

  it('未知 action 报错', async () => {
    const svc = new JobService(new Context());
    const tool = makeJobTool(config, svc);
    const res = JSON.parse(await tool.execute({ action: 'nope' } as any) as string);
    expect(res.status).toBe('error');
  });
});
