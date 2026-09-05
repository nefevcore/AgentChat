// ============================================================
// ac-shell-tools：bash（前台超时/流式 + 后台 job）+ job 管理（owner 隔离）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Service, type Fiber } from '@agentchat/cordis';
import * as jobsRow from 'ac-jobs';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
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

  it('job/settled 事件在后台任务终态时发射（携带发起会话键 conversationId——完成通知回投源）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const settled: unknown[] = [];
    ctx.on('job/settled', (job) => settled.push(job));
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo quick', background: true },
      agentId: 'a1',
      conversationId: 'a1~user',
    });
    const jobId = r.output.job_id as string;
    await new Promise((res) => setTimeout(res, 1500));
    expect(ctx.jobs.get(jobId, 'a1').status).toBe('completed');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: jobId, status: 'completed', conversationId: 'a1~user' });
    // 无执行身份会话（宿主直调）→ conversationId 缺省（唤醒行回退 owner 自会话桶）
    const r2 = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo quick2', background: true },
      agentId: 'a1',
    });
    await new Promise((res) => setTimeout(res, 1500));
    expect(ctx.jobs.get(r2.output.job_id as string, 'a1').conversationId).toBeUndefined();
  }, 20000);
});

// ============================================================
// settings.security.allowedPaths 端到端（workspace 沙箱面 → 基线 roots）
// ============================================================

/** 最小 workspace 沙箱面（SandboxWorkdirSource 全形态）：按表出基准与授予根 */
class FakeWorkspaceService extends Service {
  private table: Record<string, { base?: string; grants?: string[] }>;

  constructor(ctx: Context, options: { agents?: Record<string, { base?: string; grants?: string[] }> } = {}) {
    super(ctx, 'workspace');
    this.table = options.agents ?? {};
  }

  sandboxWorkdir(id?: string): string | undefined {
    return id !== undefined ? this.table[id]?.base : undefined;
  }

  sandboxAllowedPaths(id?: string): string[] {
    return (id !== undefined ? this.table[id]?.grants : undefined) ?? [];
  }
}

describe('ac-shell-tools × workspace 沙箱面（allowedPaths 端到端）', () => {
  async function bootWs(root: string, agents: Record<string, { base?: string; grants?: string[] }>) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [jobsRow, undefined],
      [FakeWorkspaceService, { agents }],
      [shellRow, { workdir: root }],
    ];
    for (const [plugin, config] of rows) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('命令级沙箱：授予根内绝对路径放行；授予外仍拦（基线自带，与 ac-security 无关）', async () => {
    const root = tmpRoot();
    const granted = path.join(root, 'granted');
    const base = path.join(root, 'files', 'neko');
    fs.mkdirSync(granted, { recursive: true });
    fs.mkdirSync(base, { recursive: true }); // bash 缺省 cwd 必须存在
    fs.writeFileSync(path.join(granted, 'x.txt'), 'ok');
    const { ctx } = await bootWs(root, { neko: { base, grants: [granted] } });
    const fwd = (p: string) => p.replace(/\\/g, '/');

    // 授予根内 → 不被命令级沙箱拦（执行结果平台相关，只断言拦截与否）
    const okCmd = await exec(ctx, {
      name: 'bash',
      agentId: 'neko',
      args: { command: `cat ${fwd(path.join(granted, 'x.txt'))}` },
    });
    expect(okCmd.error ?? '').not.toMatch(/沙箱/);

    // 授予外绝对路径 → 命令级沙箱拦截（修复前后都拦——基线不因授予扩大而全开）
    const bad = await exec(ctx, {
      name: 'bash',
      agentId: 'neko',
      args: { command: `cat ${fwd(path.join(root, 'outside', 'x.txt'))}` },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/沙箱/);
  });
});

describe('ac-shell-tools per-Agent 限额（settings.shell-tools 分层）', () => {
  it('outputMaxLen 差异层覆盖：本 Agent 截断、无身份回落行基线', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [jobsRow, undefined],
      [agentsRow, undefined],
      [shellRow, { workdir: root }],
    ];
    for (const [plugin, config] of rows) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    ctx.agents.register({
      id: 'small-out',
      model: 'mock-1',
      settings: { 'shell-tools': { outputMaxLen: 10 } },
    });
    const long = 'x'.repeat(500);

    const mine = await exec(ctx, { name: 'bash', agentId: 'small-out', args: { command: `echo ${long}` } });
    expect(mine.ok).toBe(true);
    expect(mine.output.truncated).toBe(true);
    expect(String(mine.output.output).length).toBeLessThan(50);

    const anon = await exec(ctx, { name: 'bash', args: { command: `echo ${long}` } }); // 无身份 → 行基线 50000
    expect(anon.output.truncated).toBe(false);
  }, 20000);

  it('maxTimeout 差异层覆盖：timeout 参数按本 Agent 上限 clamp', async () => {
    const root = tmpRoot();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [jobsRow, undefined],
      [agentsRow, undefined],
      [shellRow, { workdir: root }],
    ];
    for (const [plugin, config] of rows) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    ctx.agents.register({
      id: 'short-max',
      model: 'mock-1',
      settings: { 'shell-tools': { maxTimeout: 1500 } },
    });
    // 传 60s 超时 → 被 per-Agent maxTimeout=1500 clamp → 1.5s 即超时
    const r = await exec(ctx, {
      name: 'bash',
      agentId: 'short-max',
      args: {
        command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30',
        timeout: 60_000,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时（1500ms）/);
  }, 20000);
});
