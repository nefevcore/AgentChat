// ============================================================
// ac-issue-tools：submit_issue（fetch 桩——照 ac-web-tools 测试形态）
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as credentialsRow from 'ac-credentials';
import * as issueRow from '../src/index.ts';

type ExecRes = { ok: boolean; output: any; error?: string };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** 记录请求的 fetch 桩（缺省应答 = GitHub 形成功载荷） */
function stubFetch(
  payload: Record<string, unknown> = { html_url: 'https://github.com/nefevcore/AgentChat/issues/7', number: 7, title: 'T' },
  status = 200,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(payload), { status });
    }),
  );
  return calls;
}

async function boot(rows: Array<[unknown, unknown]>) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of rows) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return ctx;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-issue-tools submit_issue', () => {
  it('无令牌（行/凭据/env 全空）→ 可读错误指路', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const ctx = await boot([[toolsRow, undefined], [issueRow, {}]]);
    const r = await exec(ctx, { name: 'submit_issue', args: { title: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('GitHub');
    expect(r.error).toContain('GITHUB_TOKEN');
  });

  it('GitHub 缺省链路：URL/Bearer/请求体 + 进度与输出', async () => {
    const calls = stubFetch();
    const progress: string[] = [];
    const ctx = await boot([[toolsRow, undefined], [issueRow, { token: 'gh-test' }]]);
    const r = await exec(ctx, {
      name: 'submit_issue',
      args: { title: '页面打不开', body: '步骤…', labels: ['bug'] },
      onProgress: (c: string) => progress.push(c) as unknown as void,
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.github.com/repos/nefevcore/AgentChat/issues');
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer gh-test');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ title: '页面打不开', body: '步骤…', labels: ['bug'] });
    expect(r.output).toMatchObject({ number: 7, url: 'https://github.com/nefevcore/AgentChat/issues/7', server: 'github', repo: 'nefevcore/AgentChat' });
    expect(progress.join('')).toContain('#7');
  });

  it('Gitee v5：owner 进路径 + repo/access_token/labels 逗号串进 body（并集去重 + 上限 5）', async () => {
    const calls = stubFetch({ html_url: 'https://gitee.com/os/AgentChat/issues/3', number: 3, title: 'T' });
    const ctx = await boot([[toolsRow, undefined], [issueRow, { server: 'gitee', repo: 'os/AgentChat', token: 'gt-test', labels: ['feedback'] }]]);
    const r = await exec(ctx, { name: 'submit_issue', args: { title: 'x', labels: ['P0', 'bug', 'a', 'b', 'c', 'd'] } });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://gitee.com/api/v5/repos/os/issues');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ access_token: 'gt-test', repo: 'AgentChat', title: 'x' });
    expect(body.labels).toBe('feedback,P0,bug,a,b');
  });

  it('apiBase 覆盖：GitHub 兼容自建台（Gitea）前缀（含尾斜杠归一）', async () => {
    const calls = stubFetch();
    const ctx = await boot([[toolsRow, undefined], [issueRow, { apiBase: 'https://git.example.com/api/v3/', repo: 'team/agentchat', token: 't' }]]);
    const r = await exec(ctx, { name: 'submit_issue', args: { title: 'x' } });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://git.example.com/api/v3/repos/team/agentchat/issues');
  });

  it('令牌链：ac-credentials 全局 github 凭据兜底（行未直配）', async () => {
    const calls = stubFetch();
    const ctx = await boot([[toolsRow, undefined], [credentialsRow, undefined], [issueRow, {}]]);
    ctx.credentials.setGlobal('github', 'cred-key');
    const r = await exec(ctx, { name: 'submit_issue', args: { title: 'x' } });
    expect(r.ok).toBe(true);
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer cred-key');
  });

  it('per-Agent settings：repo 覆盖生效 + enabled=false 停用（settingsOf 合成）', async () => {
    const calls = stubFetch();
    const ctx = await boot([[toolsRow, undefined], [agentsRow, undefined], [issueRow, { token: 't' }]]);
    ctx.agents.register({ id: 'reporter', model: 'm', settings: { 'issue-tools': { repo: 'foo/bar' } } });
    ctx.agents.register({ id: 'muted', model: 'm', settings: { 'issue-tools': { enabled: false } } });
    const r1 = await exec(ctx, { name: 'submit_issue', args: { title: 'x' }, agentId: 'reporter' });
    expect(r1.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.github.com/repos/foo/bar/issues');
    const r2 = await exec(ctx, { name: 'submit_issue', args: { title: 'x' }, agentId: 'muted' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('停用');
  });

  it('API 错误：404 → message + 仓库/权限指路提示', async () => {
    stubFetch({ message: 'Not Found' }, 404);
    const ctx = await boot([[toolsRow, undefined], [issueRow, { token: 't' }]]);
    const r = await exec(ctx, { name: 'submit_issue', args: { title: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Not Found');
    expect(r.error).toContain('仓库不存在');
  });

  it('参数防御：title 空 → 可读错误；repo 形状非法 → 可读错误', async () => {
    const ctx = await boot([[toolsRow, undefined], [issueRow, { token: 't' }]]);
    const r1 = await exec(ctx, { name: 'submit_issue', args: { title: '  ' } });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('title');
    const r2 = await exec(ctx, { name: 'submit_issue', args: { title: 'x', repo: 'not-a-repo' } });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('owner/repo');
  });
});
