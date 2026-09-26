// ============================================================
// ac-web-tools：web_search（fetch 桩）+ browser（fake CDP endpoint）
//
// browser 侧：RowOptions.cdpEndpoint 注入 FakeCdpServer（src/
// ac-cdp-core/tests/fake-cdp.ts 复用）——旧「假守护进程」手法同构
// 平移（2026-10 CDP 化，src/docs/browser-cdp-plan.md §8）。
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as configRow from 'ac-config';
import * as credentialsRow from 'ac-credentials';
import * as webRow from '../src/index.ts';
import * as convSettingsRow from 'ac-conv-settings';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeCdpServer } from 'ac-cdp-core/src/fake-cdp.ts';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const servers: FakeCdpServer[] = [];

/** 编程好的 fake CDP：target/session 建链 + navigate/evaluate 应答 */
function newFakeCdp(): FakeCdpServer {
  const s = new FakeCdpServer();
  s.handlers.set('Target.createTarget', () => ({ targetId: 't-1' }));
  s.handlers.set('Target.attachToTarget', () => ({ sessionId: 'sess-1' }));
  s.handlers.set('Page.navigate', () => {
    setTimeout(() => s.emit('Page.loadEventFired', {}, 'sess-1'), 10);
    return { frameId: 'f-1' };
  });
  s.handlers.set('Runtime.evaluate', (p: Record<string, unknown>) => {
    const expr = String(p.expression);
    const v = expr.includes('location.href') ? 'https://example.com/'
      : expr.includes('document.title') ? 'Example'
      : expr.includes('scrollY') ? 600
      : expr.includes('scrollHeight') ? 3000
      : expr.includes("querySelector") ? null
      : 2; // eval 1+1
    return { result: { value: v } };
  });
  servers.push(s);
  return s;
}

async function boot(options: Record<string, unknown> = {}) {
  const server = newFakeCdp();
  const port = await server.listen();
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [webRow, { cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser/abc`, timeoutMs: 5000, idleTimeoutMs: 0, ...options }],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).browser) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers, server };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const s of servers.splice(0)) await s.close();
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
    const server = newFakeCdp();
    const port = await server.listen();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [configRow, undefined],
      [credentialsRow, undefined],
      [toolsRow, undefined],
      [webRow, { cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser/abc`, timeoutMs: 5000, idleTimeoutMs: 0 }],
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
    ctx.credentials.setGlobal('searchpool:main', '***');
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
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer ***');
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
      onProgress: (c: string) => progress.push(c) as unknown as void,
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

describe('ac-web-tools browser（CDP 直连——fake endpoint）', () => {
  it('open：导航 + href/title 回读 + marker 携带', async () => {
    const { ctx, server } = await boot();
    const r = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://example.com' } });
    expect(r.ok).toBe(true);
    expect(r.output.url).toBe('https://example.com/');
    expect(r.output.title).toBe('Example');
    expect(typeof r.output.marker).toBe('number');
    // 命令走 flat session
    const nav = server.calls.find((c: { method: string }) => c.method === 'Page.navigate');
    expect(nav?.sessionId).toBe('sess-1');
  });

  it('open 自动补协议：无 scheme → https://', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'example.com' } });
    expect(r.ok).toBe(true);
    expect(r.output.url).toBe('https://example.com/');
  });

  it('eval：结果 JSON 序列化截断', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'browser', args: { action: 'eval', js: '1+1' } });
    expect(r.ok).toBe(true);
    expect(r.output.result).toBe('2');
  });

  it('logs：诊断缓冲经 marker 取（console error + 失败请求）', async () => {
    const { ctx, server } = await boot();
    await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' } });
    server.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] }, 'sess-1');
    server.emit('Network.requestWillBeSent', { requestId: 'r9', request: { method: 'GET', url: 'https://a/x' }, type: 'XHR' }, 'sess-1');
    server.emit('Network.loadingFailed', { requestId: 'r9', errorText: 'net::ERR_FAILED' }, 'sess-1');
    await new Promise((r) => setTimeout(r, 50));
    const r1 = await exec(ctx, { name: 'browser', args: { action: 'logs', kind: 'error' } });
    expect(r1.ok).toBe(true);
    expect(r1.output.console).toHaveLength(1);
    expect(r1.output.console[0].text).toBe('boom');
    expect(r1.output.network[0].error).toBe('net::ERR_FAILED');
    // marker 语义：since = 当前 marker 后无新条目
    const marker = r1.output.marker as number;
    const r2 = await exec(ctx, { name: 'browser', args: { action: 'logs', kind: 'error', since: marker } });
    expect(r2.output.console).toHaveLength(0);
  });

  it('response_body：pending 拒绝（loadingFinished 硬门槛）', async () => {
    const { ctx, server } = await boot();
    await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' } });
    server.emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a' } }, 'sess-1');
    await new Promise((r) => setTimeout(r, 30));
    const r1 = await exec(ctx, { name: 'browser', args: { action: 'response_body', requestId: 'r1' } });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('尚未完成');
  });

  it('tabs：page 清单 + active 标记', async () => {
    const { ctx, server } = await boot();
    server.handlers.set('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 't-1', type: 'page', title: 'Example', url: 'https://example.com/' },
        { targetId: 't-2', type: 'page', title: 'Other', url: 'https://other/' },
        { targetId: 't-3', type: 'background_page', title: 'bg', url: 'chrome://bg' },
      ],
    }));
    const r = await exec(ctx, { name: 'browser', args: { action: 'tabs' } });
    expect(r.ok).toBe(true);
    expect(r.output.tabs).toHaveLength(2);
    expect(r.output.tabs[0]).toMatchObject({ active: true, title: 'Example' });
  });

  it('close 动作：会话关闭（再调用重新 boot）', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, { name: 'browser', args: { action: 'close' } });
    expect(r.ok).toBe(true);
    expect(ctx.browser.running).toBe(false);
    // 重新 boot（fake endpoint 恒在）
    const r2 = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' } });
    expect(r2.ok).toBe(true);
  });

  it('boot 失败拒绝式收束：endpoint 不可达 → 可读错误（C4 语义保留）', async () => {
    // 动态取一个「已关闭」的端口（127.0.0.1 高位端口稳定拒绝，避免 9 端口平台差异）
    const probe = new FakeCdpServer();
    const deadPort = await probe.listen();
    await probe.close();
    const ctx = new Context();
    const fiber0 = ctx.plugin(toolsRow as any);
    const fiber = ctx.plugin(webRow as any, { cdpEndpoint: `ws://127.0.0.1:${deadPort}/devtools/browser/abc`, bootTimeoutMs: 1000, timeoutMs: 2000, idleTimeoutMs: 0 });
    await fiber0; await fiber;
    const fibers = [fiber0, fiber];
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).tools && (ctx as any).browser) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers });
    const r = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/连接|超时|失败/);
  });

  it('steps 批量 + continue_on_error', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, {
      name: 'browser',
      args: {
        steps: [
          { action: 'open', url: 'https://a' },
          { action: 'press', key: 'Enter', repeat: 2, delay_ms: 5 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.output.count).toBe(3);
  });

  it('dispose：服务随行卸载注销（树杀/dispose 骨架保留）', async () => {
    const { ctx, fibers } = await boot();
    await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' } });
    expect(ctx.browser.running).toBe(true);
    await fibers[1].dispose();
    await new Promise((res) => setTimeout(res, 200));
    expect((ctx as any).browser).toBeUndefined();
  });
});

describe('ac-web-tools browser 分层门禁（web + observe/manipulate/inject）', () => {
  /** 带 agents 行的 boot（分层门禁需要标签注册表面；无 agents 恒放行） */
  async function bootWithAgents() {
    const server = newFakeCdp();
    const port = await server.listen();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [toolsRow, undefined],
      [agentsRow, undefined],
      [webRow, { cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser/abc`, timeoutMs: 5000, idleTimeoutMs: 0 }],
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

  it('observe 层级：open/read/logs 放行；click 需 manipulate、eval 需 inject（错误指名层级）', async () => {
    const { ctx } = await bootWithAgents();
    ctx.agents.register({ id: 'surfer', model: 'm', tags: ['web', 'observe'] });
    const open = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' }, agentId: 'surfer' });
    expect(open.ok).toBe(true);
    const logs = await exec(ctx, { name: 'browser', args: { action: 'logs' }, agentId: 'surfer' });
    expect(logs.ok).toBe(true);
    const click = await exec(ctx, { name: 'browser', args: { action: 'click', ref: 1 }, agentId: 'surfer' });
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
    const click = await exec(ctx, { name: 'browser', args: { action: 'press', key: 'Enter' }, agentId: 'actor' });
    expect(click.ok).toBe(true);
    const ev = await exec(ctx, { name: 'browser', args: { action: 'eval', js: '1' }, agentId: 'actor' });
    expect(ev.ok).toBe(false);
    ctx.agents.register({ id: 'pwner', model: 'm', tags: ['web', 'inject'] });
    const ev2 = await exec(ctx, { name: 'browser', args: { action: 'eval', js: '1' }, agentId: 'pwner' });
    expect(ev2.ok).toBe(true);
  });

  it('无身份（agents 在场）：门禁适用（tier 0 全拦）', async () => {
    const { ctx } = await bootWithAgents();
    const anon = await exec(ctx, { name: 'browser', args: { action: 'read' } });
    expect(anon.ok).toBe(false);
    expect(anon.error).toContain('observe');
  });

  it('能力集同源：capabilities 覆盖层已删除——存量值不再计入层级（回归锁定）', async () => {
    const { ctx } = await bootWithAgents();
    ctx.agents.register({ id: 'legacy', model: 'm', settings: { security: { capabilities: ['manipulate'] } } });
    const click = await exec(ctx, { name: 'browser', args: { action: 'press', key: 'Enter' }, agentId: 'legacy' });
    expect(click.ok).toBe(false); // 能力授权单源 = tags（access-tier §9.4）
  });

  // ---- 会话级浏览器档（conv-settings browserTier——「实验性 → 浏览器」钮）----

  /** 带 agents + conv-settings 行的 boot（会话覆盖消费面） */
  async function bootWithConvSettings() {
    const server = newFakeCdp();
    const port = await server.listen();
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const [plugin, config] of [
      [toolsRow, undefined],
      [agentsRow, undefined],
      [convSettingsRow, { root: path.join(os.tmpdir(), `ac-cs-${Date.now().toString(36)}`) }],
      [webRow, { cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser/abc`, timeoutMs: 5000, idleTimeoutMs: 0 }],
    ] as Array<[unknown, unknown]>) {
      const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
      await fiber;
      fibers.push(fiber);
    }
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).tools && (ctx as any).browser && (ctx as any).agents && (ctx as any).convSettings) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers });
    return { ctx, fibers };
  }

  it('browserTier 会话覆盖：observe Agent 会话提权 manipulate → click 放行', async () => {
    const { ctx } = await bootWithConvSettings();
    ctx.agents.register({ id: 'reader', model: 'm', tags: ['web', 'observe'] });
    // 基线：tags 档 click 被拦
    const before = await exec(ctx, { name: 'browser', args: { action: 'press', key: 'Enter' }, agentId: 'reader', conversationId: 'user~reader' });
    expect(before.ok).toBe(false);
    // 会话覆盖 manipulate → 同一会话放行
    ctx.convSettings.set('user~reader', { browserTier: 'manipulate' });
    const after = await exec(ctx, { name: 'browser', args: { action: 'press', key: 'Enter' }, agentId: 'reader', conversationId: 'user~reader' });
    expect(after.ok).toBe(true);
    // 其他会话不受影响（无覆盖回落 tags）
    ctx.agents.register({ id: 'reader2', model: 'm', tags: ['web', 'observe'] });
    const other = await exec(ctx, { name: 'browser', args: { action: 'press', key: 'Enter' }, agentId: 'reader2', conversationId: 'user~reader2' });
    expect(other.ok).toBe(false);
  });

  it('browserTier 可见性通路：无 tags Agent + 会话授权 → browser 进 LLM 工具面（sessionCapsOf 注入 grants）', async () => {
    const { ctx } = await bootWithConvSettings();
    // 无任何 tags 的 Agent（默认预设形态）——browser requiredTags ['web','observe'] 原不可见
    ctx.agents.register({ id: 'plain', model: 'm', tags: [] });
    // 无会话授权：工具面无 browser
    const toolsFace = (convId?: string) =>
      ctx.tools.list().filter((t) => {
        const { sessionCapsOf, toolAllowedFor } = require('ac-agents') as typeof import('ac-agents');
        return t.injection !== 'mode' && toolAllowedFor(t, sessionCapsOf(ctx, 'plain', convId));
      }).map((t) => t.name);
    expect(toolsFace('user~plain')).not.toContain('browser');
    // 会话授权 observe → browser 可见（等效注入 web+observe）
    ctx.convSettings.set('user~plain', { browserTier: 'observe' });
    expect(toolsFace('user~plain')).toContain('browser');
    // 其他会话不受影响
    expect(toolsFace('user~other')).not.toContain('browser');
  });

  it('browserTier=disabled：inject Agent 也被拦（会话级禁用优先于一切）', async () => {
    const { ctx } = await bootWithConvSettings();
    ctx.agents.register({ id: 'pwner', model: 'm', tags: ['web', 'inject'] });
    ctx.convSettings.set('user~pwner', { browserTier: 'disabled' });
    const r = await exec(ctx, { name: 'browser', args: { action: 'open', url: 'https://a' }, agentId: 'pwner', conversationId: 'user~pwner' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已被本会话禁用');
  });
});
