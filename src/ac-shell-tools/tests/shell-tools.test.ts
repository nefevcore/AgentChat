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

  it('ANSI 颜色码清理：彩色输出（vitest/pwsh 场景）返回纯文本', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 用户反馈实例形态：红色 × + 反显 + 耗时着色（跨 chunk 撕裂由汇总处清理兜底）
    const cmd =
      process.platform === 'win32'
        ? 'Write-Host "begin" -NoNewline; [Console]::Write([char]27 + "[31m× fail" + [char]27 + "[0m " + [char]27 + "[32m43ms" + [char]27 + "[39m"); Write-Host "end"'
        : 'printf "begin\\033[31m× fail\\033[0m \\033[32m43ms\\033[39mend\\n"';
    const r = await exec(ctx, { name: 'bash', args: { command: cmd } });
    expect(r.ok).toBe(true);
    const out = String(r.output.output);
    expect(out).not.toMatch(/[\u001b\u009b]/); // 无转义序列残留
    expect(out).toContain('× fail'); // 可读文本保留
    expect(out).toContain('43ms');
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

  it('基线 tierOf 感知（§9.3）：full 档跳过命令扫描与 workdir 白名单；base/sandbox 照拦', async () => {
    const root = tmpRoot();
    // 带 agents 行的 boot（档位判定 tierOf 单源需要注册表）
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [toolsRow, undefined],
      [jobsRow, undefined],
      [agentsRow, undefined],
      [shellRow, { workdir: root }],
    ] as Array<[unknown, unknown]>) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    booted.push({ ctx, fibers });
    ctx.agents.register({ id: 'basea', model: 'm', tags: ['shell'] });
    ctx.agents.register({ id: 'sandboxa', model: 'm', tags: ['shell', 'sandbox-access'] });
    ctx.agents.register({ id: 'fulla', model: 'm', tags: ['shell', 'full-access'] });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-shell-out-'));
    tmps.push(outside);

    // base：越界 workdir 被白名单拦
    const baseWd = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo ok', workdir: outside },
      agentId: 'basea',
    });
    expect(baseWd.ok).toBe(false);
    expect(baseWd.error).toMatch(/沙箱/);
    // base：越界绝对路径命令被扫描拦
    const baseCmd = await exec(ctx, {
      name: 'bash',
      args: { command: 'cat /etc/passwd' },
      agentId: 'basea',
    });
    expect(baseCmd.ok).toBe(false);
    expect(baseCmd.error).toMatch(/沙箱/);

    // sandbox：软边界仍生效（同 base——扫描不随 sandbox 跳过）
    const sandboxCmd = await exec(ctx, {
      name: 'bash',
      args: { command: 'cat /etc/passwd' },
      agentId: 'sandboxa',
    });
    expect(sandboxCmd.ok).toBe(false);
    expect(sandboxCmd.error).toMatch(/沙箱/);

    // full："不做任何限制"的字面义——workdir 白名单与命令扫描都跳过
    //（命令实际执行；断言只看失败原因不是沙箱）
    const fullWd = await exec(ctx, {
      name: 'bash',
      args: { command: 'echo full-ok', workdir: outside },
      agentId: 'fulla',
    });
    expect(fullWd.ok).toBe(true);
    expect(String(fullWd.output?.output ?? '')).toContain('full-ok');
    const fullCmd = await exec(ctx, {
      name: 'bash',
      args: { command: 'cat /etc/passwd' },
      agentId: 'fulla',
    });
    expect(fullCmd.error ?? '').not.toMatch(/沙箱/);

    // 审批 elevation（base + call.elevation=full）同款跳过
    const elevated = await exec(ctx, {
      name: 'bash',
      args: { command: 'cat /etc/passwd', workdir: outside },
      agentId: 'basea',
      elevation: 'full-access',
    });
    expect(elevated.error ?? '').not.toMatch(/沙箱/);
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

  it('close 悬挂兜底（2026-09-12 卡死修复）：命令派生长活后代持有 stdout 管道 → exit 宽限后强制收束，工具不再永挂', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 孙进程继承本端 stdout 管道且比命令活得久——修复前 child 'close' 永不
    // 触发（exit 已到、管道被持有；taskkill /T 树杀按父子链，脱离者漏杀），
    // 工具 Promise 永挂 → run 卡死、前端流式态永真（"得刷新才恢复"）。
    // 修复后：exit 起 CLOSE_FALLBACK_MS 宽限，close 仍不来即销毁本端读端
    // 强制收束（输出已随 exit 收齐）。孙进程 8s 自杀；Windows 分支 cwd 避开
    // 测试临时目录（宽限收束后还活着——占住 afterEach 要删的目录会 EPERM），
    // Linux 分支 cwd 即 workdir（Unix rm 不受进程占用目录影响，无 EPERM 面）。
    const cmd = process.platform === 'win32'
      ? `$p = Start-Process node -ArgumentList '-e','setTimeout(()=>{},8000)' -WorkingDirectory $env:TEMP -NoNewWindow -PassThru; Start-Sleep -Milliseconds 300; echo spawned-ok`
      : `(node -e 'setTimeout(()=>{},8000)' &) ; sleep 0.3; echo spawned-ok`;
    const r = await exec(ctx, { name: 'bash', args: { command: cmd } });
    expect(r.ok).toBe(true); // 命令本身正常退出（exit 0）——活孙进程不再拖挂工具
    expect(String(r.output.output)).toContain('spawned-ok');
    expect(r.output.exit_code).toBe(0);
  }, 20000);

  it('后台执行：立即返回 job_id；job list/kill/logs 全链路 + owner 隔离', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 20; echo done' : 'sleep 20; echo done', background: true, description: '长时间等待验证后台链路' },
      agentId: 'agent-a',
    });
    expect(r.ok).toBe(true);
    const jobId = r.output.job_id as string;
    expect(jobId).toMatch(/^bash-1$/);
    // label = 意图优先的展示标签（会话头 chip / 侧边栏面板 / job list 共用）；
    // 原始命令恒存 meta.command（tooltip 详情层）
    expect(ctx.jobs.get(jobId, 'agent-a').label).toBe('长时间等待验证后台链路');
    expect(ctx.jobs.get(jobId, 'agent-a').meta?.command).toBe(process.platform === 'win32' ? 'Start-Sleep -Seconds 20; echo done' : 'sleep 20; echo done');

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
    // 轮询等待（全量并行下的负载容忍——固定 sleep 在重载下漏拍）
    const waitFor = async (cond: () => boolean, ms = 8000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const r = await exec(ctx, {
      name: 'bash',
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
      name: 'bash',
      args: { command: 'echo quick2', background: true },
      agentId: 'a1',
    });
    const jobId2 = r2.output.job_id as string;
    await waitFor(() => ctx.jobs.get(jobId2, 'a1').status === 'completed');
    expect(ctx.jobs.get(jobId2, 'a1').conversationId).toBeUndefined();
  }, 20000);
});

// ============================================================
// settings.security.allowedPaths 端到端（workspace 沙箱面 → 基线 roots）
// ============================================================

/** 最小 workspace 沙箱面（SandboxWorkdirSource 全形态）：按表出基准与授予根；
 *  sessions 表模拟 singles 挂载（conversationId → 基准指向工作区根） */
class FakeWorkspaceService extends Service {
  private table: Record<string, { base?: string; grants?: string[] }>;
  private sessions: Record<string, string>;

  constructor(
    ctx: Context,
    options: {
      agents?: Record<string, { base?: string; grants?: string[] }>;
      sessions?: Record<string, string>;
    } = {},
  ) {
    super(ctx, 'workspace');
    this.table = options.agents ?? {};
    this.sessions = options.sessions ?? {};
  }

  sandboxWorkdir(id?: string, conversationId?: string): string | undefined {
    const session = conversationId !== undefined ? this.sessions[conversationId] : undefined;
    if (session) return session;
    return id !== undefined ? this.table[id]?.base : undefined;
  }

  sandboxAllowedPaths(id?: string): string[] {
    return (id !== undefined ? this.table[id]?.grants : undefined) ?? [];
  }
}

describe('ac-shell-tools × workspace 沙箱面（allowedPaths 端到端）', () => {
  async function bootWs(
    root: string,
    agents: Record<string, { base?: string; grants?: string[] }>,
    sessions: Record<string, string> = {},
  ) {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    const rows: Array<[unknown, unknown]> = [
      [toolsRow, undefined],
      [jobsRow, undefined],
      [FakeWorkspaceService, { agents, sessions }],
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

  it('singles 会话挂载工作区 = 会话级工作目录：bash 缺省 cwd 指向工作区根；未挂会话仍锚专用空间', async () => {
    const root = tmpRoot();
    const base = path.join(root, 'files', 'neko');
    const project = path.join(root, 'project');
    fs.mkdirSync(base, { recursive: true }); // bash 缺省 cwd 必须存在
    fs.mkdirSync(project, { recursive: true });
    const { ctx } = await bootWs(root, { neko: { base } }, { 'sid-attached': project });

    // 挂载会话：缺省 cwd = 工作区根（相对命令自然落工作区——Agent 主战场）
    const attached = await exec(ctx, {
      name: 'bash',
      agentId: 'neko',
      conversationId: 'sid-attached',
      args: { command: 'echo in-workspace' },
    });
    expect(attached.ok).toBe(true);
    expect(attached.output.cwd).toBe(project);

    // 同一 Agent 的未挂会话：cwd 仍锚 Agent 专用空间（分桶不串）
    const bare = await exec(ctx, {
      name: 'bash',
      agentId: 'neko',
      conversationId: 'sid-bare',
      args: { command: 'echo in-agent-space' },
    });
    expect(bare.ok).toBe(true);
    expect(bare.output.cwd).toBe(base);
  }, 20000);
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

  it('timeout=0 显式不限：无计时器——挂起命令不被缺省 30s 收束（依赖 signal 收束）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const controller = new AbortController();
    const pending = exec(ctx, {
      name: 'bash',
      args: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeout: 0 },
      signal: controller.signal,
    });
    // 超过缺省 30s 的观察窗内（3.2s > CLOSE_FALLBACK_MS + KILL_CONFIRM_MS
    // 余量）没有超时收束——不限时生效；signal abort 收束工具
    setTimeout(() => controller.abort(), 3200);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error ?? '').not.toMatch(/超时/);
  }, 20000);

  it('kill 存活确认看门狗（永挂补丁）：树杀后轮询确认进程死亡——超时收束不被 kill 失败拖挂', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const r = await exec(ctx, {
      name: 'bash',
      args: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeout: 1500 },
    });
    // 断言超时口径收束（非永挂）——正常路径 taskkill/组杀生效，看门狗
    // 在轮询首拍确认死亡后即停
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时（1500ms）/);
  }, 20000);
});
