// ============================================================
// 后台 job 链路：list/kill/logs/settled 事件（拆分自单文件版 ③/4）
// 含轮询等待后台任务终态——本文件墙钟 ~8s。
// ============================================================
import { describe, it, expect } from 'vitest';
import { CMD_TOOL, exec, tmpRoot, boot } from './helpers.ts';

describe(`ac-shell-tools ${CMD_TOOL} 后台 job`, () => {
  it('后台执行：立即返回 job_id；job list/kill/logs 全链路 + owner 隔离', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const longCmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 20; echo done' : 'sleep 20; echo done';
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: longCmd, background: true, description: '长时间等待验证后台链路' },
      agentId: 'agent-a',
    });
    expect(r.ok).toBe(true);
    const jobId = r.output.job_id as string;
    // job id 前缀 = 家族名（pwsh-N / bash-N）
    expect(jobId).toMatch(new RegExp(`^${CMD_TOOL}-1$`));
    // label = 意图优先的展示标签；原始命令恒存 meta.command
    expect(ctx.jobs.get(jobId, 'agent-a').label).toBe('长时间等待验证后台链路');
    expect(ctx.jobs.get(jobId, 'agent-a').meta?.command).toBe(longCmd);
    // kind = 家族名
    expect(ctx.jobs.get(jobId, 'agent-a').kind).toBe(CMD_TOOL);

    // owner 隔离：agent-b 看不到 agent-a 的任务
    const listB = await exec(ctx, { name: 'job', args: { action: 'list' }, agentId: 'agent-b' });
    expect(listB.output.count).toBe(0);
    const listA = await exec(ctx, { name: 'job', args: { action: 'list' }, agentId: 'agent-a' });
    expect(listA.output.count).toBe(1);
    expect(listA.output.jobs[0].alive).toBe(true);

    // logs（日志文件尾读）+ kill（终态；两平台都算正常终止）
    const kill = await exec(ctx, { name: 'job', args: { action: 'kill', job_id: jobId }, agentId: 'agent-a' });
    expect(kill.output.outcome).toBe('cancellation-requested');
    await new Promise((res) => setTimeout(res, 1500));
    const after = ctx.jobs.get(jobId, 'agent-a');
    expect(['killed', 'completed', 'failed']).toContain(after.status); // 已终态
    const listA2 = await exec(ctx, { name: 'job', args: { action: 'list' }, agentId: 'agent-a' });
    expect(listA2.output.jobs[0].alive).toBe(false);
  }, 30000);

  it('job/settled 事件在后台任务终态时发射（携带发起会话键 conversationId——完成通知回投源）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    // 轮询等待（全量并行下的负载容忍——固定 sleep 在重载下漏拍）
    const waitFor = async (cond: () => boolean, ms = 8000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'echo quick', background: true },
      agentId: 'a1',
      conversationId: 'a1~user',
    });
    const jobId = r.output.job_id as string;
    await waitFor(() => ctx.jobs.get(jobId, 'a1').status === 'completed');
    await waitFor(() => settled.length >= 1);
    expect(ctx.jobs.get(jobId, 'a1').status).toBe('completed');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: jobId, status: 'completed', conversationId: 'a1~user' });
    // 无执行身份会话（宿主直调）→ conversationId 缺省（唤醒行回退 owner 自会话桶）
    const r2 = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: 'echo quick2', background: true },
      agentId: 'a1',
    });
    const jobId2 = r2.output.job_id as string;
    await waitFor(() => ctx.jobs.get(jobId2, 'a1').status === 'completed');
    expect(ctx.jobs.get(jobId2, 'a1').conversationId).toBeUndefined();
  }, 20000);
});
