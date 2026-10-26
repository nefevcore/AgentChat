// ============================================================
// auto-title.test.ts —— 壳侧会话命名行（cr-672）：首步后 LLM 概括 →
// 标题请求信封 → 邮局（本测监听真 ipc，帧捕获断言）；幂等 / 回落 / 无邮局
// 三面。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Service, FiberStates, type Fiber } from '@agentchat/cordis';
import { makeAutoTitleRow } from '../src/auto-title.ts';
import { listenIpc, type PostOfficeServer } from 'ac-post-office';
import { socketPathFor, type Envelope } from 'ac-envelope-core';

const ROOT = path.resolve('sandbox', 'test-auto-title-' + process.pid);

interface ChatCall { model: string; messages: Array<{ role: string; content: string }>; [key: string]: unknown }

class StubLlm extends Service {
  readonly calls: ChatCall[] = [];
  reply = '会话命名标题';
  fail = false;
  constructor(ctx: Context) { super(ctx, 'llm'); }
  async chat(input: ChatCall): Promise<{ text: string }> {
    this.calls.push(input);
    if (this.fail) throw new Error('provider down');
    return { text: this.reply };
  }
}

beforeEach(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); });
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const runRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'mock',
  messages: [{ role: 'user', content: '继续 AgentChat preview 轨' }],
  conversationId: 'c1',
  sender: 'user',
  source: 'user',
  ...over,
});

const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  index: 0, text: '', reasoning: '用户在继续 preview 轨的重建工作', toolCalls: [], ...over,
});

const envelopeOf = (conversationId = 'c1'): Record<string, unknown> => ({ conversationId, sender: 'user', source: 'user' });

async function boot(postOfficeAddress?: string) {
  const ctx = new Context();
  const llmFiber = ctx.plugin(class extends StubLlm { constructor(c: Context) { super(c); } });
  await llmFiber;
  const rowFiber = ctx.plugin(makeAutoTitleRow({ dataRoot: ROOT, agentId: 'alpha', ...(postOfficeAddress !== undefined ? { postOfficeAddress } : {}) }));
  await rowFiber;
  expect(rowFiber.state).toBe(FiberStates.ACTIVE);
  const emit = (event: string, ...args: unknown[]): void => { (ctx.emit as unknown as (e: string, ...a: unknown[]) => void)(event, ...args); };
  return { ctx, llm: (ctx as unknown as { llm: StubLlm }).llm, emit, fibers: [rowFiber, llmFiber] as Fiber[] };
}

async function dispose(fibers: Fiber[]): Promise<void> {
  for (const f of fibers) if (f.uid !== null) await f.dispose();
}

describe('壳侧会话命名行（cr-672）', () => {
  it('首步后生成：素材 = 首条用户消息 + Agent 首步思考 → 标题请求信封送达', async () => {
    const address = socketPathFor(ROOT, 'post-office');
    const frames: unknown[] = [];
    const server: PostOfficeServer = await listenIpc(address, (frame) => { frames.push(frame); return { ok: true }; });
    const h = await boot(address);
    try {
      h.emit('loop/run-started', runRequest());
      h.emit('loop/after-step', 'alpha', step(), envelopeOf());
      await waitFor(() => frames.length > 0);
      const env = frames[0] as Envelope;
      expect(env).toMatchObject({ uuid: 'title-c1', sender: 'alpha', to: 'host', kind: 'message', budget: 0 });
      expect(env.payload).toMatchObject({ conversationId: 'c1', title: '会话命名标题', agent: 'alpha' });
      // 思考禁用双词汇 + 素材含用户消息与 Agent 首步思考
      expect(h.llm.calls).toHaveLength(1);
      expect(h.llm.calls[0]).toMatchObject({ model: 'mock', thinking: { type: 'disabled' }, reasoning_effort: 'none' });
      expect(h.llm.calls[0]!.messages[0]!.content).toContain('用户在继续 preview 轨的重建工作');
      // 同代第二轮不再重算（已处置集合）
      h.emit('loop/run-started', runRequest());
      h.emit('loop/after-step', 'alpha', step(), envelopeOf());
      await new Promise((r) => setTimeout(r, 100));
      expect(h.llm.calls).toHaveLength(1);
      expect(frames).toHaveLength(1);
    } finally {
      await dispose(h.fibers);
      await server.close();
    }
  });

  it('盘上已有标题（含用户手改）→ 不生成不投递', async () => {
    const dir = path.join(ROOT, 'viewer', 'sessions', 'c1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: 'c1', title: '手改标题' }), 'utf-8');
    const address = socketPathFor(ROOT, 'po-existing');
    const frames: unknown[] = [];
    const server = await listenIpc(address, (frame) => { frames.push(frame); return { ok: true }; });
    const h = await boot(address);
    try {
      h.emit('loop/run-started', runRequest());
      h.emit('loop/after-step', 'alpha', step(), envelopeOf());
      await new Promise((r) => setTimeout(r, 120));
      expect(h.llm.calls).toHaveLength(0);
      expect(frames).toHaveLength(0);
    } finally {
      await dispose(h.fibers);
      await server.close();
    }
  });

  it('非用户会话 / 机制 run / 日期快照行首消息 → 不定名', async () => {
    const address = socketPathFor(ROOT, 'po-gates');
    const frames: unknown[] = [];
    const server = await listenIpc(address, (frame) => { frames.push(frame); return { ok: true }; });
    const h = await boot(address);
    try {
      h.emit('loop/run-started', runRequest({ conversationId: 'agent-pair', source: 'agent' }));
      h.emit('loop/after-step', 'alpha', step(), envelopeOf('agent-pair'));
      h.emit('loop/run-started', runRequest({ conversationId: 'mech', meta: { 'archive-review': true } }));
      h.emit('loop/after-step', 'alpha', step(), envelopeOf('mech'));
      h.emit('loop/run-started', runRequest({ conversationId: 'dated', messages: [{ role: 'user', content: '[当前时间] 2026-10-24 周五' }] }));
      h.emit('loop/after-step', 'alpha', step(), envelopeOf('dated'));
      await new Promise((r) => setTimeout(r, 120));
      expect(h.llm.calls).toHaveLength(0);
      expect(frames).toHaveLength(0);
    } finally {
      await dispose(h.fibers);
      await server.close();
    }
  });

  it('LLM 失败 → 截断回落标题（24 字上限 + 省略号）仍投递', async () => {
    const address = socketPathFor(ROOT, 'po-fallback');
    const frames: unknown[] = [];
    const server = await listenIpc(address, (frame) => { frames.push(frame); return { ok: true }; });
    const h = await boot(address);
    h.llm.fail = true;
    try {
      const long = '这是一条非常长的用户消息'.repeat(4);
      h.emit('loop/run-started', runRequest({ conversationId: 'c2', messages: [{ role: 'user', content: long }] }));
      h.emit('loop/after-step', 'alpha', step(), envelopeOf('c2'));
      await waitFor(() => frames.length > 0);
      const title = (frames[0] as Envelope & { payload: { title: string } }).payload.title;
      expect(title.endsWith('…')).toBe(true);
      expect(title.length).toBe(25);
    } finally {
      await dispose(h.fibers);
      await server.close();
    }
  });

  it('run 无步完成（after-run 兜底）→ 截断回落仍投递；无邮局形态恒不命名', async () => {
    const address = socketPathFor(ROOT, 'po-after-run');
    const frames: unknown[] = [];
    const server = await listenIpc(address, (frame) => { frames.push(frame); return { ok: true }; });
    const h = await boot(address);
    try {
      // after-run 兜底同样走 LLM（只是没有 Agent 首步素材——素材面缺省）
      h.emit('loop/run-started', runRequest({ conversationId: 'c3' }));
      h.emit('loop/after-run', runRequest({ conversationId: 'c3' }));
      await waitFor(() => frames.length > 0);
      expect((frames[0] as Envelope & { payload: { title: string } }).payload.title).toBe('会话命名标题');
      expect(h.llm.calls).toHaveLength(1);
      expect(h.llm.calls[0]!.messages[0]!.content).not.toContain('Agent 的初步思考');
    } finally {
      await dispose(h.fibers);
      await server.close();
    }
    const offline = await boot();
    try {
      offline.emit('loop/run-started', runRequest());
      offline.emit('loop/after-step', 'alpha', step(), envelopeOf());
      await new Promise((r) => setTimeout(r, 100));
      expect(offline.llm.calls).toHaveLength(0);
    } finally {
      await dispose(offline.fibers);
    }
  });
});
