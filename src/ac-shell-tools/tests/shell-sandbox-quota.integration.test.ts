// ============================================================
// 沙箱面与 per-Agent 限额（拆分自单文件版 ④/4）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as jobsRow from 'ac-jobs';
import * as agentsRow from 'ac-agents';
import { CMD_TOOL, SLEEP_30, exec, tmpRoot, bootRows } from './helpers.ts';
import * as shellRow from '../src/index.ts';

// ============================================================
// settings.security.allowedPaths 端到端（workspace 沙箱面 → 基线 roots）
// ============================================================

/** 最小 workspace 沙箱面（SandboxWorkdirSource 全形态） */
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
    return bootRows([
      [toolsRow, undefined],
      [jobsRow, undefined],
      [FakeWorkspaceService, { agents, sessions }],
      [shellRow, { workdir: root }],
    ]);
  }

  it('命令级沙箱：授予根内绝对路径放行；授予外仍拦（基线自带，与 ac-security 无关）', async () => {
    const root = tmpRoot();
    const granted = path.join(root, 'granted');
    const base = path.join(root, 'files', 'neko');
    fs.mkdirSync(granted, { recursive: true });
    fs.mkdirSync(base, { recursive: true }); // 命令工具缺省 cwd 必须存在
    fs.writeFileSync(path.join(granted, 'x.txt'), 'ok');
    const { ctx } = await bootWs(root, { neko: { base, grants: [granted] } });
    const fwd = (p: string) => p.replace(/\\/g, '/');

    // 授予根内 → 不被命令级沙箱拦（执行结果平台相关，只断言拦截与否）
    const okCmd = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'neko',
      args: { command: `cat ${fwd(path.join(granted, 'x.txt'))}` },
    });
    expect(okCmd.error ?? '').not.toMatch(/沙箱/);

    // 授予外绝对路径 → 命令级沙箱拦截
    const bad = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'neko',
      args: { command: `cat ${fwd(path.join(root, 'outside', 'x.txt'))}` },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/沙箱/);
  });

  it('singles 会话挂载工作区 = 会话级工作目录：缺省 cwd 指向工作区根；未挂会话仍锚专用空间', async () => {
    const root = tmpRoot();
    const base = path.join(root, 'files', 'neko');
    const project = path.join(root, 'project');
    fs.mkdirSync(base, { recursive: true }); // 缺省 cwd 必须存在
    fs.mkdirSync(project, { recursive: true });
    const { ctx } = await bootWs(root, { neko: { base } }, { 'sid-attached': project });

    // 挂载会话：缺省 cwd = 工作区根
    const attached = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'neko',
      conversationId: 'sid-attached',
      args: { command: 'echo in-workspace' },
    });
    expect(attached.ok).toBe(true);
    expect(attached.output.cwd).toBe(project);

    // 同一 Agent 的未挂会话：cwd 仍锚 Agent 专用空间（分桶不串）
    const bare = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'neko',
      conversationId: 'sid-bare',
      args: { command: 'echo in-agent-space' },
    });
    expect(bare.ok).toBe(true);
    expect(bare.output.cwd).toBe(base);
  }, 20000);
});

describe('ac-shell-tools per-Agent 限额（settings.shell-tools 分层）', () => {
  async function bootQuota(root: string) {
    return bootRows([
      [toolsRow, undefined],
      [jobsRow, undefined],
      [agentsRow, undefined],
      [shellRow, { workdir: root }],
    ]);
  }

  it('outputMaxLen 差异层覆盖：本 Agent 截断、无身份回落行基线', async () => {
    const root = tmpRoot();
    const { ctx } = await bootQuota(root);
    ctx.agents.register({
      id: 'small-out',
      model: 'mock-1',
      settings: { 'shell-tools': { outputMaxLen: 10 } },
    });
    const long = 'x'.repeat(500);

    const mine = await exec(ctx, { name: CMD_TOOL, agentId: 'small-out', args: { command: `echo ${long}` } });
    expect(mine.ok).toBe(true);
    expect(mine.output.truncated).toBe(true);
    expect(String(mine.output.output).length).toBeLessThan(50);

    const anon = await exec(ctx, { name: CMD_TOOL, args: { command: `echo ${long}` } }); // 无身份 → 行基线 50000
    expect(anon.output.truncated).toBe(false);
  }, 20000);

  it('maxTimeout 差异层覆盖：timeout 参数按本 Agent 上限 clamp', async () => {
    const root = tmpRoot();
    const { ctx } = await bootQuota(root);
    ctx.agents.register({
      id: 'short-max',
      model: 'mock-1',
      settings: { 'shell-tools': { maxTimeout: 1500, timeoutAction: 'kill' } },
    });
    // 传 60s 超时 → 被 per-Agent maxTimeout=1500 clamp → 1.5s 即超时
    // （timeoutAction=kill：clamp 用例钉树杀旧行为，handoff 见专项件）
    const r = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'short-max',
      args: { command: SLEEP_30, timeout: 60_000 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时（1500ms）/);
  }, 20000);

  it('timeout=0 显式不限：无计时器——挂起命令不被缺省 30s 收束（依赖 signal 收束）', async () => {
    const root = tmpRoot();
    const { ctx } = await bootQuota(root);
    const controller = new AbortController();
    const pending = exec(ctx, {
      name: CMD_TOOL,
      agentId: undefined,
      args: { command: SLEEP_30, timeout: 0 },
      signal: controller.signal,
    });
    // 超过缺省 30s 的观察窗内没有超时收束——不限时生效
    setTimeout(() => controller.abort(), 3200);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error ?? '').not.toMatch(/超时/);
  }, 20000);

  it('kill 存活确认看门狗（永挂补丁）：树杀后轮询确认进程死亡——超时收束不被 kill 失败拖挂', async () => {
    const root = tmpRoot();
    const { ctx } = await bootQuota(root);
    // timeoutAction=kill：本用例钉树杀路径（看门狗收束）；handoff 见专项件
    ctx.agents.register({
      id: 'wd-kill',
      model: 'mock-1',
      settings: { 'shell-tools': { timeoutAction: 'kill' } },
    });
    const r = await exec(ctx, {
      name: CMD_TOOL,
      agentId: 'wd-kill',
      args: { command: SLEEP_30, timeout: 1500 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时（1500ms）/);
    expect(r.output.job_id).toBeUndefined();
  }, 20000);
});
