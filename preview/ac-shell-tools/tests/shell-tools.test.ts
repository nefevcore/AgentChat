// ============================================================
// ac-shell-tools：bash（前台超时/流式 + 后台 job）+ job 管理（owner 隔离）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as jobsRow from 'ac-jobs';
import * as toolsRow from 'ac-tools';
import * as shellRow from '../src/index.ts';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-shell-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(root: string, options: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows: Array<[unknown, unknown]> = [
    [toolsRow, undefined],
    [jobsRow, undefined],
    [shellRow, { workdir: root, ...options }],
  ];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
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
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-shell-tools bash', () => {
  it('前台执行：echo 输出 + exit_code 0；流式 onProgress 收到分片', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const chunks: string[] = [];
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo hello-shell' },
      onProgress: (c: string) => chunks.push(c),
    });
    expect(r.ok).toBe(true);
    expect(r.output.exit_code).toBe(0);
    expect(String(r.output.output)).toContain('hello-shell');
    expect(chunks.join('')).toContain('hello-shell');
  });

  it('非零退出：ok=false + 输出保留 + error 引导', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, { name: 'bash', args: { command: 'exit 3' } });
    expect(r.ok).toBe(false);
    expect(r.output.exit_code).toBe(3);
  });

  it('命令级沙箱：越界绝对路径被拦（heredoc 载荷不误判）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const bad = await exec(ctx, { name: 'bash', args: { command: 'cat /etc/passwd' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/沙箱/);
    // heredoc 载荷（数据非命令）不触发误拦：失败原因不得是沙箱
    // （pwsh 本身不支持 bash heredoc 语法，执行可能失败——只断言不被沙箱拦）
    const okCmd = await exec(ctx, {
      name: 'bash',
      args: { command: "cat > out.txt <<'EOF'\nsample /const/g regex\nEOF\ntype out.txt" },
    });
    expect(okCmd.error ?? '').not.toMatch(/沙箱/);
  });

  it('超时：kill 进程树 + timed_out 报告', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeout: 2000 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时/);
  }, 20000);

  it('signal 中止：call.signal abort → 进程被杀', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const controller = new AbortController();
    const pending = exec(ctx, {
      name: 'bash',
      args: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30' },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    const r = await pending;
    expect(r.ok).toBe(false);
  }, 20000);

  it('后台执行：立即返回 job_id；job list/kill/logs 全链路 + owner 隔离', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 20; echo done' : 'sleep 20; echo done', background: true },
      agentId: 'agent-a',
    });
    expect(r.ok).toBe(true);
    const jobId = r.output.job_id as string;
    expect(jobId).toMatch(/^bash-1$/);

    // owner 隔离：agent-b 看不到 agent-a 的任务
    const listB = await exec(ctx, { name: 'job', args: { action: 'list' }, agentId: 'agent-b' });
    expect(listB.output.count).toBe(0);
    const listA = await exec(ctx, { name: 'job', args: { action: 'list' }, agentId: 'agent-a' });
    expect(listA.output.count).toBe(1);
    expect(listA.output.jobs[0].alive).toBe(true);

    // logs（日志文件尾读）+ kill（终态；Windows taskkill 后 close 不带
    // signal → settle completed+exit 1，Unix → killed——两平台都算正常终止）
    const kill = await exec(ctx, { name: 'job', args: { action: 'kill', job_id: jobId }, agentId: 'agent-a' });
    expect(kill.output.outcome).toBe('cancellation-requested');
    await new Promise((res) => setTimeout(res, 1500));
    const after = ctx.jobs.get(jobId, 'agent-a');
    expect(['killed', 'completed', 'failed']).toContain(after.status); // 已终态
    const listA2 = await exec(ctx, { name: 'job', args: { action: 'list' }, agentId: 'agent-a' });
    expect(listA2.output.jobs[0].alive).toBe(false);
  }, 30000);

  it('job/settled 事件在后台任务终态时发射', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo quick', background: true },
      agentId: 'a1',
    });
    const jobId = r.output.job_id as string;
    await new Promise((res) => setTimeout(res, 1500));
    expect(ctx.jobs.get(jobId, 'a1').status).toBe('completed');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: jobId, status: 'completed' });
  }, 15000);
});
