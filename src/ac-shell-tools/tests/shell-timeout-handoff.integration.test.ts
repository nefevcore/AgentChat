// ============================================================
// 超时 handoff（2026-12）：timeoutAction=handoff 时前台超时自动
// 转后台 job——不杀进程、输出改道日志文件、job_id 随结果返回。
// kill 旧行为的回归在 lifecycle/quota 件（显式传 timeoutAction）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { CMD_TOOL, SLEEP_30, exec, tmpRoot, boot, bootRows } from './helpers.ts';
import * as toolsRow from 'ac-tools';
import * as jobsRow from 'ac-jobs';
import * as agentsRow from 'ac-agents';
import * as shellRow from '../src/index.ts';
import type { Context } from '@agentchat/cordis';

/**
 * kill 后台 job 并等终态：树杀是异步的（stopping → cancel → 进程死 → killed），
 * 不等会在 afterEach 删 tmp 目录时 EPERM（子进程 cwd 占住目录）。
 */
async function killAndWait(ctx: Context, jobId: string): Promise<void> {
  ctx.jobs.kill(jobId);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const j = ctx.jobs.get(jobId);
    if (j.status === 'completed' || j.status === 'killed' || j.status === 'failed') return;
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe(`ac-shell-tools ${CMD_TOOL} 超时 handoff`, () => {
  it('缺省行为（未配置 timeoutAction）：超时转后台——timeout_action=handoff + job_id + 快照输出，进程不死', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: `${SLEEP_30}; echo handoff-done`, timeout: 2000 },
    });
    expect(r.ok).toBe(false); // 超时仍是 ok:false（前台视角未完成）
    expect(r.error).toMatch(/超时（2000ms）/);
    expect(r.error).toMatch(/转后台/);
    expect(r.output.timeout_action).toBe('handoff');
    expect(typeof r.output.job_id).toBe('string');
    expect(typeof r.output.log_file).toBe('string');
    // 进程仍活：job list 里 running
    const job = ctx.jobs.list().find((j) => j.id === r.output.job_id);
    expect(job?.status).toBe('running');
    // 清理：kill 该 job 并等终态（防 afterEach EPERM）
    await killAndWait(ctx, r.output.job_id);
  }, 20000);

  it('handoff 后日志持续积累：转后台后新增输出进日志文件（job logs 可读）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: `echo before-timeout; ${SLEEP_30}; echo after-timeout`, timeout: 2000 },
    });
    expect(r.output.timeout_action).toBe('handoff');
    expect(String(r.output.output)).toContain('before-timeout'); // 快照含超时前输出
    // 等日志落盘（后台 pump 异步写）
    await new Promise((res) => setTimeout(res, 800));
    const log = String(r.output.log_file);
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, 'utf-8')).toContain('before-timeout'); // 落盘点含已累积输出
    await killAndWait(ctx, r.output.job_id);
  }, 20000);

  it('timeoutAction=kill（settings 差异层）：旧行为——树杀 + timed_out 报告，无 job 登记', async () => {
    const root = tmpRoot();
    const { ctx } = await bootRows([
      [toolsRow, undefined],
      [jobsRow, undefined],
      [agentsRow, undefined],
      [shellRow, { workdir: root }],
    ]);
    ctx.agents.register({
      id: 'killa',
      model: 'mock-1',
      settings: { 'shell-tools': { timeoutAction: 'kill' } },
    });
    const r = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'killa',
      args: { command: SLEEP_30, timeout: 1500 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时（1500ms）/);
    expect(r.error).not.toMatch(/转后台/);
    expect(r.output.job_id).toBeUndefined(); // kill 路径不登记 job
    expect(ctx.jobs.size).toBe(0);
  }, 20000);

  it('handoff 与显式 background 语义分立：background=true 立即返回 job（无超时概念）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: CMD_TOOL,
      args: { command: SLEEP_30, background: true, timeout: 1000 },
    });
    expect(r.ok).toBe(true);
    expect(r.output.background).toBe(true);
    expect(typeof r.output.job_id).toBe('string');
    await killAndWait(ctx, r.output.job_id);
  }, 20000);
});
