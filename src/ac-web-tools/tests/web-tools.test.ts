// ============================================================
// ac-web-tools：web_search（fetch 桩）+ browser（假守护进程）
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as configRow from 'ac-config';
import * as credentialsRow from 'ac-credentials';
import * as webRow from '../src/index.ts';
import { resolveDaemonScriptArg } from '../src/browser.ts';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** 假守护进程：ready 握手 + 回显 ok 应答 */
const FAKE_DAEMON = `
process.stdout.write(JSON.stringify({status:'ready'}) + '\\n');
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const cmd = JSON.parse(line);
    process.stdout.write(JSON.stringify({ status: 'ok', action: cmd.action, echo: cmd }) + '\\n');
  } catch {}
});
`;

async function boot(options: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [webRow, { command: ['node', '-e', FAKE_DAEMON], timeoutMs: 5000, ...options }],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  // 嵌套 Service fiber（BrowserService）就绪可能落后于行 fiber——轮询等服务面可用
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).browser) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('resolveDaemonScriptArg（相对脚本路径按 workspace 数据根解析；返回值为去可执行文件的 argv）', () => {
  it('相对 .py 路径 → 拼数据根；绝对路径/无 root/无 .py 参数原样', () => {
    const root = 'C:\\data\\home';
    const args = resolveDaemonScriptArg(['python', 'files/shared/scripts/browser_daemon.py'], root);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/browser_daemon\.py$/);
    expect(args[0]!.startsWith(root)).toBe(true);
    // 绝对路径原样
    expect(resolveDaemonScriptArg(['python', 'C:/abs/daemon.py'], root)).toEqual(['C:/abs/daemon.py']);
    // root 缺省原样（调用方自行保证可解析）
    expect(resolveDaemonScriptArg(['python', 'files/x.py'], undefined)).toEqual(['files/x.py']);
    // 无 .py 参数的显式 command（测试注入）原样
    expect(resolveDaemonScriptArg(['node', '-e', 'code'], root)).toEqual(['-e', 'code']);
  });
});

describe('ac-web-tools web_search', () => {
  it('未知 provider → 可读错误列出可选项', async () => {
    const { ctx } = await boot({ provider: 'nope' });
    const r = await exec(ctx, { name: 'web_search', args: { query: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tavily');
  });

  it('无 key（行/凭据/env 全空）→ validateConfig 报可读错误（缺省 deepseek，2026-10）', async () => {
    const { ctx } = await boot(); // 无池无行配置 → 内置缺省 deepseek
    const r = await exec(ctx, { name: 'web_search', args: { query: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('DeepSeek');
  });

  it('搜索引擎池接线：config.searchProviders default 条目供缺省 provider/参数/key（全局设置页控制）', async () => {
    // 带 config + credentials 行（池读 config.get；池 key 走 searchpool:<名> 全局凭据）
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [configRow, undefined],
      [credentialsRow, undefined],
      [toolsRow, undefined],
      [webRow, { command: ['node', '-e', FAKE_DAEMON], timeoutMs: 5000 }],
    ] as Array<[unknown, unknown]>) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).tools && (ctx as any).browser && (ctx as any).config && (ctx as any).credentials) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers });

    ctx.config.set('searchProviders', { main: { provider: 'tavily', default: true, defaultResults: 3 } });
    ctx.credentials.setGlobal('searchpool:main', 'tvly-pool');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ query: 'hello', results: [{ title: 'T1', url: 'https://a', content: 'c1', score: 0.9, raw_content: null }] }),
          { status: 200 },
        );
      }),
    );
    const r = await exec(ctx, { name: 'web_search', args: { query: 'hello' } });
    expect(r.ok).toBe(true);
    expect(r.output.provider).toBe('tavily');
    expect(calls[0].url).toBe('https://api.tavily.com/search');
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer tvly-pool');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ query: 'hello', max_results: 3 });
  });

  it('行级 apiKeys + fetch 桩：完整链路（请求体/标准化输出/进度回调）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            query: 'hello',
            results: [
              { title: 'T1', url: 'https://a', content: 'c1', score: 0.9, raw_content: null },
              { title: 'T2', url: 'https://b', content: 'c2', score: 0.8, raw_content: 'x'.repeat(3000) },
            ],
            answer: 'ans',
            usage: { credits: 1 },
          }),
          { status: 200 },
        );
      }),
    );
    const progress: string[] = [];
    const { ctx } = await boot({ provider: 'tavily', apiKeys: { tavily: 'tvly-test' } });
    const r = await exec(ctx, {
      name: 'web_search',
      args: { query: 'hello', max_results: 2 },
      onProgress: (c: string) => progress.push(c),
    });
    expect(r.ok).toBe(true);
    expect(r.output.provider).toBe('tavily');
    expect(r.output.results).toHaveLength(2);
    expect(r.output.answer).toBe('ans');
    expect(r.output.credits_used).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.tavily.com/search');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ query: 'hello', max_results: 2 });
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer tvly-test');
    // raw_content 截断（默认 2000）
    expect(((r.output.results[1] as { raw_content?: string }).raw_content ?? '').length).toBeLessThanOrEqual(2001);
    expect(progress.join('')).toContain('Tavily');
  });

  it('API 错误响应 → 可读错误（含 detail.error）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: { error: 'quota exceeded' } }), { status: 432 })),
    );
    const { ctx } = await boot({ provider: 'tavily', apiKeys: { tavily: 'k' } });
    const r = await exec(ctx, { name: 'web_search', args: { query: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('quota exceeded');
  });
});

describe('ac-web-tools browser（ctx.browser 守护进程）', () => {
  it('send：ready 握手 + 命令应答；请求队列串行', async () => {
    const { ctx } = await boot();
    expect(ctx.browser.running).toBe(false);
    const r1 = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://example.com' } });
    expect(r1.ok).toBe(true);
    expect(ctx.browser.running).toBe(true);
    // 并发命令经队列逐条应答
    const [a, b] = await Promise.all([
      ctx.browser.send({ action: 'content' }),
      ctx.browser.send({ action: 'html' }),
    ]);
    expect(JSON.parse(a)).toMatchObject({ status: 'ok', action: 'content' });
    expect(JSON.parse(b)).toMatchObject({ status: 'ok', action: 'html' });
  });

  it('steps 批量 + continue_on_error', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, {
      name: 'browser',
      args: {
        steps: [
          { action: 'open', url: 'https://a' },
          { action: 'click', selector: '#x', repeat: 2, delay_ms: 5 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.output.count).toBe(3);
  });

  it('close 动作关闭守护进程；dispose 杀进程', async () => {
    const { ctx, fibers } = await boot();
    await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' } });
    expect(ctx.browser.running).toBe(true);
    const r = await exec(ctx, { name: 'browser', args: { action: 'close' } });
    expect(r.ok).toBe(true);
    expect(ctx.browser.running).toBe(false);
    // 重启再由 dispose 杀进程 + 注销服务
    await ctx.browser.send({ action: 'open' });
    await fibers[1].dispose();
    await new Promise((res) => setTimeout(res, 200));
    expect((ctx as any).browser).toBeUndefined(); // 服务随行卸载注销
  });

  // ---- C4（2026-08-31 审计）：boot 挂死 / FIFO 错位 / 失败当成功 ----

  it('C4 回归：daemon 永不 ready → boot 超时拒绝式收束（不永久挂死）', async () => {
    const { ctx } = await boot({
      command: ['node', '-e', 'setInterval(() => {}, 60000);'], // 活着但不握手
      bootTimeoutMs: 300,
      timeoutMs: 5000,
    });
    await expect(ctx.browser.send({ action: 'open' })).rejects.toThrow(/握手超时/);
    expect(ctx.browser.running).toBe(false);
  });

  it('C4 回归：spawn 失败 → send 可读错误（失败当成功 + EPIPE 不再）', async () => {
    const { ctx } = await boot({ command: ['no-such-daemon-bin-xyz', '--flag'] });
    await expect(ctx.browser.send({ action: 'open' })).rejects.toThrow(/启动失败/);
    // 失败已收束：状态清干净，再次调用是重新 boot 而非对死 stdin 写
    await expect(ctx.browser.send({ action: 'open' })).rejects.toThrow();
  });

  it('C4 回归：daemon 启动即退出 → send 拒绝（不再 resolve 假成功）', async () => {
    const { ctx } = await boot({ command: ['node', '-e', 'process.exit(3);'] });
    await expect(ctx.browser.send({ action: 'open' })).rejects.toThrow(/即退出/);
  });

  it('C4 回归：单命令超时 → kill 重置对齐（无错位 resolve；可重启恢复）', async () => {
    const { ctx } = await boot({
      command: ['node', '-e', `
        process.stdout.write(JSON.stringify({status:'ready'}) + '\\n');
        const rl = require('readline').createInterface({ input: process.stdin });
        let stuck = false;
        rl.on('line', (line) => {
          const cmd = JSON.parse(line);
          if (cmd.__slow) { stuck = true; return; } // 卡死命令：串行协议下后续命令全部悬置
          if (stuck) return;
          process.stdout.write(JSON.stringify({ status: 'ok', action: cmd.action }) + '\\n');
        });
      `],
      timeoutMs: 400,
    });
    const [t1, t2] = await Promise.allSettled([
      ctx.browser.send({ action: 'stuck', __slow: true }),
      ctx.browser.send({ action: 'queued' }),
    ]);
    expect(t1.status).toBe('rejected');
    expect((t1 as PromiseRejectedResult).reason.message).toMatch(/browser timeout/);
    // 排队中的第二条一并失败（对齐重置）——而非晚到的错位应答
    expect(t2.status).toBe('rejected');
    expect(ctx.browser.running).toBe(false);
    // 重置后：下次调用重新 boot，命令-应答对齐恢复
    const ok = await ctx.browser.send({ action: 'open' });
    expect(JSON.parse(ok)).toMatchObject({ status: 'ok', action: 'open' });
  });
});

describe('ac-web-tools browser 分层门禁（web + observe/manipulate/inject）', () => {
  /** 带 agents 行的 boot（分层门禁需要标签注册表面；无 agents 恒放行） */
  async function bootWithAgents() {
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [toolsRow, undefined],
      [agentsRow, undefined],
      [webRow, { command: ['node', '-e', FAKE_DAEMON], timeoutMs: 5000 }],
    ] as Array<[unknown, unknown]>) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).tools && (ctx as any).browser && (ctx as any).agents) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('observe 层级：open/content 放行；click 需 manipulate、eval 需 inject（错误指名层级）', async () => {
    const { ctx } = await bootWithAgents();
    ctx.agents.register({ id: 'surfer', model: 'm', tags: ['web', 'observe'] });
    const open = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' }, agentId: 'surfer' });
    expect(open.ok).toBe(true);
    const click = await exec(ctx, { name: 'browser', args: { action: 'click', selector: '#x' }, agentId: 'surfer' });
    expect(click.ok).toBe(false);
    expect(click.error).toContain('manipulate');
    const ev = await exec(ctx, { name: 'browser', args: { action: 'eval', js: '1' }, agentId: 'surfer' });
    expect(ev.ok).toBe(false);
    expect(ev.error).toContain('inject');
  });

  it('steps 批量载荷按最高需求动作判定（observe 夹带 eval → 整体拦截）', async () => {
    const { ctx } = await bootWithAgents();
    ctx.agents.register({ id: 'reader', model: 'm', tags: ['web', 'observe'] });
    const r = await exec(ctx, {
      name: 'browser',
      args: { steps: [{ action: 'open', url: 'https://a' }, { action: 'eval', js: '1' }] },
      agentId: 'reader',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('inject');
  });

  it('层级嵌套：manipulate 可 click 不可 eval；inject 全放行', async () => {
    const { ctx } = await bootWithAgents();
    ctx.agents.register({ id: 'actor', model: 'm', tags: ['web', 'manipulate'] });
    const click = await exec(ctx, { name: 'browser', args: { action: 'click', selector: '#x' }, agentId: 'actor' });
    expect(click.ok).toBe(true);
    const ev = await exec(ctx, { name: 'browser', args: { action: 'eval', js: '1' }, agentId: 'actor' });
    expect(ev.ok).toBe(false);
    ctx.agents.register({ id: 'pwner', model: 'm', tags: ['web', 'inject'] });
    const ev2 = await exec(ctx, { name: 'browser', args: { action: 'eval', js: '1' }, agentId: 'pwner' });
    expect(ev2.ok).toBe(true);
  });

  it('无身份（agents 在场）：门禁适用（tier 0 全拦）', async () => {
    const { ctx } = await bootWithAgents();
    const anon = await exec(ctx, { name: 'browser', args: { action: 'content' } });
    expect(anon.ok).toBe(false);
    expect(anon.error).toContain('observe');
  });

  it('能力集同源：settings.security.capabilities 覆盖层计入层级', async () => {
    const { ctx } = await bootWithAgents();
    ctx.agents.register({ id: 'legacy', model: 'm', settings: { security: { capabilities: ['manipulate'] } } });
    const click = await exec(ctx, { name: 'browser', args: { action: 'click', selector: '#x' }, agentId: 'legacy' });
    expect(click.ok).toBe(true);
  });
});
