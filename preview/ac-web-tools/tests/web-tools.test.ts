// ============================================================
// ac-web-tools：web_search（fetch 桩）+ browser（假守护进程）
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as webRow from '../src/index.ts';
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

describe('ac-web-tools web_search', () => {
  it('未知 provider → 可读错误列出可选项', async () => {
    const { ctx } = await boot({ provider: 'nope' });
    const r = await exec(ctx, { name: 'web_search', args: { query: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tavily');
  });

  it('无 key（行/凭据/env 三源全空）→ validateConfig 报可读错误', async () => {
    const { ctx } = await boot(); // tavily 缺省
    const r = await exec(ctx, { name: 'web_search', args: { query: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Tavily');
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
});
