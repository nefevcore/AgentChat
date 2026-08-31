// ============================================================
// ac-durable-interaction：状态机/幂等/持久化恢复 + ask_questions 工具
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as diRow from '../src/index.ts';
import { MemoryDurableInteractionStore, JsonlDurableInteractionStore } from '../src/index.ts';
type ExecRes = { ok: boolean; output: any; error?: string; interrupt?: any };
async function exec(ctx: Context, call: Record<string, unknown>): Promise<ExecRes> {
  return (await ctx.tools.execute(call as never)) as ExecRes;
}

const tmps: string[] = [];
function tmpFile(name = 'interactions.jsonl'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-di-'));
  tmps.push(dir);
  return path.join(dir, name);
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot(options: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const [plugin, config] of [
    [toolsRow, undefined],
    [diRow, options],
  ] as Array<[unknown, unknown]>) {
    const fiber = config === undefined ? ctx.plugin(plugin as any) : ctx.plugin(plugin as any, config);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).durableInteraction) break;
    await new Promise((r) => setTimeout(r, 1));
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

describe('store 状态机与幂等（src 语义原样）', () => {
  it('memory 后端：open → pending；reply 幂等（duplicate 返回原回答）；close 双保险', () => {
    const store = new MemoryDurableInteractionStore();
    const rec = store.open({ key: 'conv1', kind: 'ask_questions', payload: { q: 1 } });
    expect(rec.state).toBe('pending');
    const r1 = store.reply(rec.id, ['A']);
    expect(r1.status).toBe('ok');
    const r2 = store.reply(rec.id, ['B']);
    expect(r2.status).toBe('duplicate');
    expect(r2.answer).toEqual(['A']);
    expect(store.close(rec.id, 'consumed')).toBe(true);
    expect(store.close(rec.id, 'again')).toBe(false); // 已关闭
    expect(store.reply(rec.id, ['C']).status).toBe('closed');
    expect(store.listOpen()).toHaveLength(0);
  });

  it('jsonl 后端：write-ahead + 崩溃恢复（torn tail 忽略 + last-write-wins）', () => {
    const file = tmpFile();
    const store = new JsonlDurableInteractionStore(file);
    const rec = store.open({ key: 'k', kind: 'approval', payload: { level: 1 }, id: 'fix-1' });
    store.reply(rec.id, { ok: true });
    // 手工追加 torn tail（半行）
    fs.appendFileSync(file, '{"id":"broken","state":"pen', 'utf-8');
    // 重新构造（模拟重启恢复）
    const restored = new JsonlDurableInteractionStore(file);
    const got = restored.get('fix-1');
    expect(got).toMatchObject({ state: 'answered', answer: { ok: true } });
    expect(restored.listOpen()).toHaveLength(0);
  });
});

describe('ac-durable-interaction 服务 + 三事件', () => {
  it('open/reply/close 各发事件（write-ahead：opened 先于返回可见）', async () => {
    const file = tmpFile();
    const { ctx } = await boot({ backend: 'jsonl', file });
    const events: string[] = [];
    ctx.on('durable-interaction/opened', (p) => events.push(`opened:${p.id}`));
    ctx.on('durable-interaction/replied', (p) => events.push(`replied:${p.id}`));
    ctx.on('durable-interaction/closed', (p) => events.push(`closed:${p.id}`));

    const rec = ctx.durableInteraction.open({ key: 'k1', kind: 'ask_questions', payload: [] });
    expect(events).toEqual([`opened:${rec.id}`]);
    // 落盘已发生（write-ahead）
    expect(fs.readFileSync(file, 'utf-8')).toContain(rec.id);
    expect(ctx.durableInteraction.reply(rec.id, ['ans']).status).toBe('ok');
    expect(events).toContain(`replied:${rec.id}`);
    // duplicate 不发事件
    ctx.durableInteraction.reply(rec.id, ['other']);
    expect(events.filter((e) => e.startsWith('replied'))).toHaveLength(1);
    expect(ctx.durableInteraction.close(rec.id, 'consumed')).toBe(true);
    expect(events).toContain(`closed:${rec.id}`);
  });
});

describe('ask_questions 工具（write-ahead + 事件等待 + late-reply 对账键）', () => {
  it('事件驱动回答：reply 后工具唤醒并拿到 answers；correlationId=toolCallId', async () => {
    const { ctx } = await boot();
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-42',
    });
    // 等待 opened 落盘
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect(open).toMatchObject({ kind: 'ask_questions', correlationId: 'call-42', owner: 'helper' });
    ctx.durableInteraction.reply(open.id, ['A']);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(r.output.answers).toEqual(['A']);
    expect(r.output.interaction_id).toBe(open.id);
  });

  it('超时：close(timeout) + 可读错误', async () => {
    const { ctx } = await boot();
    const r = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }], timeout_ms: 120 },
      agentId: 'a',
      conversationId: 'a',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
    expect(ctx.durableInteraction.listOpen()).toHaveLength(0); // 已 close
  });

  it('signal 中止：close(aborted)', async () => {
    const { ctx } = await boot();
    const controller = new AbortController();
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }] },
      agentId: 'a',
      conversationId: 'a',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('中止');
  });

  it('参数校验：空 questions / 无会话上下文', async () => {
    const { ctx } = await boot();
    const noQ = await exec(ctx, { name: 'ask_questions', args: { questions: [] }, conversationId: 'a' });
    expect(noQ.ok).toBe(false);
    const noConv = await exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q', options: ['x'] }] },
    });
    expect(noConv.ok).toBe(false);
    expect(noConv.error).toContain('会话上下文');
  });
});
