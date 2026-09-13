// ============================================================
// ac-durable-interaction：状态机/幂等/持久化恢复 + ask_questions 工具
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe('缺省 jsonl 落盘（2026-09-12：后端重启丢挂起提问修正）', () => {
  it('裸行（无 config）缺省落盘：重启后 pending 恢复（修复前缺省 memory——重启全丢，前端 interaction/list 无从恢复）', async () => {
    // 数据根 = 测试 cwd ./data（vitest setup 已 chdir 到 worker 桶）
    const file = path.resolve('./data/interactions.jsonl');
    fs.rmSync(file, { force: true });
    const { ctx } = await boot();
    ctx.durableInteraction.open({ key: 'conv-x', kind: 'ask_questions', payload: { questions: [] }, owner: 'a' });
    // 落盘已发生
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('conv-x');
  });

  it('重启恢复：同根重新构造 → pending 记录可见（jsonl last-write-wins 折叠）', () => {
    const file = tmpFile('restart.jsonl');
    const s1 = new JsonlDurableInteractionStore(file);
    s1.open({ key: 'k', kind: 'ask_questions', payload: { q: 1 }, id: 'dur-restart-1', owner: 'a' });
    // 模拟重启（进程内存丢失）：重新构造加载同一文件
    const s2 = new JsonlDurableInteractionStore(file);
    expect(s2.get('dur-restart-1')).toMatchObject({ state: 'pending', key: 'k', owner: 'a' });
    expect(s2.listOpen({ key: 'k' })).toHaveLength(1);
  });
});

describe('一周保留期清理（sweep：终态过期删除 + pending 保护 + 折叠）', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  /** 手工铺一份带时间戳的 jsonl（模拟历史文件） */
  function seed(file: string, rows: Array<{ id: string; state: string; ageMs: number }>): void {
    const now = Date.now();
    fs.writeFileSync(
      file,
      rows
        .map(({ id, state, ageMs }) =>
          JSON.stringify({
            id, key: 'k', kind: 'ask_questions', payload: {},
            state, createdAt: now - ageMs, updatedAt: now - ageMs,
          }))
        .join('\n') + '\n',
      'utf-8',
    );
  }

  it('终态过期删除：answered/closed 超 7 天清掉，一周内保留；文件折叠成每 id 一行', () => {
    const file = tmpFile();
    seed(file, [
      { id: 'old-a', state: 'answered', ageMs: WEEK + 1000 },
      { id: 'old-c', state: 'closed', ageMs: WEEK + 1000 },
      { id: 'new-a', state: 'answered', ageMs: WEEK - 1000 },
    ]);
    const store = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    expect(store.get('old-a')).toBeUndefined();
    expect(store.get('old-c')).toBeUndefined();
    expect(store.get('new-a')).toMatchObject({ state: 'answered' });
    // 文件已折叠：恰好 1 行
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('new-a');
  });

  it('pending 永不清理（write-ahead 恢复源）——再老也保留', () => {
    const file = tmpFile();
    seed(file, [
      { id: 'ancient-p', state: 'pending', ageMs: WEEK * 10 },
      { id: 'old-a', state: 'answered', ageMs: WEEK * 10 },
    ]);
    const store = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    expect(store.get('ancient-p')).toMatchObject({ state: 'pending' });
    expect(store.get('old-a')).toBeUndefined();
    expect(store.listOpen()).toHaveLength(1);
  });

  it('边界：updatedAt 恰好等于 cutoff（now - retention）→ 删（闭区间外保留语义）', () => {
    const file = tmpFile();
    const t = Date.now();
    seed(file, [{ id: 'edge', state: 'answered', ageMs: 0 }]);
    // 手工把 updatedAt 精确设为 t - WEEK，sweep(now=t) 判过期
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8').split('\n')[0]!);
    raw.updatedAt = t - WEEK;
    fs.writeFileSync(file, JSON.stringify(raw) + '\n', 'utf-8');
    const store = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    store.sweep(t);
    expect(store.get('edge')).toBeUndefined();
  });

  it('折叠重写保留多代行为历史中最新的投影（pending→answered 两行 → 一行 answered）', () => {
    const file = tmpFile();
    const s1 = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    const rec = s1.open({ key: 'k', kind: 'ask_questions', payload: {}, id: 'multi-1' });
    s1.reply(rec.id, ['A']);
    // 两行（open + reply）
    expect(fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())).toHaveLength(2);
    // 构造时 sweep（retention 内不删）→ 折叠成一行 answered
    const s2 = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    expect(fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())).toHaveLength(1);
    expect(s2.get('multi-1')).toMatchObject({ state: 'answered', answer: ['A'] });
  });

  it('retentionMs 未配置 = 不清理只折叠（历史全留缺省）', () => {
    const file = tmpFile();
    seed(file, [
      { id: 'keep-1', state: 'answered', ageMs: WEEK * 100 },
      { id: 'keep-2', state: 'closed', ageMs: WEEK * 100 },
    ]);
    const store = new JsonlDurableInteractionStore(file); // 无 retentionMs
    expect(store.list()).toHaveLength(2);
    expect(fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())).toHaveLength(2);
  });

  it('空投影折叠：全部终态过期 → 文件清空（0 行）且不留残片', () => {
    const file = tmpFile();
    seed(file, [{ id: 'gone', state: 'answered', ageMs: WEEK * 2 }]);
    const store = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    expect(store.list()).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('');
    // 无 .compact 残片
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.compact'))).toHaveLength(0);
  });

  it('干净文件构造不重写（启动路径只读）——mtime 不变', () => {
    const file = tmpFile();
    seed(file, [
      { id: 'p1', state: 'pending', ageMs: 1000 },
      { id: 'a1', state: 'answered', ageMs: 2000 },
    ]);
    const before = fs.statSync(file).mtimeMs;
    new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('service 面：写口后懒 sweep（一次性定时器摊平写入）；sweepDelayMs=0 立即折叠', async () => {
    const file = tmpFile();
    const { ctx } = await boot({ backend: 'jsonl', file, sweepDelayMs: 0 });
    // open + reply 两行
    const rec = ctx.durableInteraction.open({ key: 'k', kind: 'ask_questions', payload: {} });
    ctx.durableInteraction.reply(rec.id, ['A']);
    expect(fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())).toHaveLength(2);
    // 定时器到期（0ms）后一次折叠
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())).toHaveLength(1);
  });

  it('service 面：retentionMs: null 显式关闭清理（终态永留，只折叠）', async () => {
    const file = tmpFile();
    seed(file, [{ id: 'kept', state: 'answered', ageMs: WEEK * 10 }]);
    const { ctx } = await boot({ backend: 'jsonl', file, retentionMs: null });
    expect(ctx.durableInteraction.get('kept')).toMatchObject({ state: 'answered' });
  });

  it('service 面：裸行缺省 = 一周保留期（行为冒烟：过期终态构造即清）', async () => {
    const file = tmpFile();
    seed(file, [{ id: 'expired', state: 'answered', ageMs: WEEK + 5000 }]);
    const { ctx } = await boot({ backend: 'jsonl', file });
    expect(ctx.durableInteraction.get('expired')).toBeUndefined();
  });

  it('memory 后端：sweep 面 = 0（无持久化可清）', async () => {
    const { ctx } = await boot({ backend: 'memory' });
    expect(ctx.durableInteraction.sweep()).toBe(0);
  });

  it('崩溃安全：折叠重写后重载 → 投影一致（写入端 fsync + rename 替换）', () => {
    const file = tmpFile();
    const s1 = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    const rec = s1.open({ key: 'k', kind: 'ask_questions', payload: {}, id: 'crash-1' });
    s1.reply(rec.id, ['B']);
    // 手工触发 sweep 折叠，模拟重启后重载
    s1.sweep();
    const s2 = new JsonlDurableInteractionStore(file, { retentionMs: WEEK });
    expect(s2.get('crash-1')).toMatchObject({ state: 'answered', answer: ['B'] });
  });

  it('dispose 收掉挂起的 sweep 定时器（不留悬挂 handle）', async () => {
    const file = tmpFile();
    const { ctx, fibers } = await boot({ backend: 'jsonl', file, sweepDelayMs: 10_000 });
    ctx.durableInteraction.open({ key: 'k', kind: 'ask_questions', payload: {} });
    // fibers dispose 由 afterEach 统一收；此处验证 dispose 后文件仍完好可重载
    for (const f of [...fibers].reverse()) {
      if (f.uid !== null) await f.dispose();
    }
    const store = new JsonlDurableInteractionStore(file);
    expect(store.listOpen()).toHaveLength(1);
  });
});

describe('late-reply 唤醒（run 已死时的作答回投）', () => {
  async function bootWithConversation(
    running: Array<{ agentId: string; conversationId: string }>,
    deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }>,
  ) {
    const { Service } = await import('@agentchat/cordis');
    class ConvStub extends Service {
      constructor(c: Context) {
        super(c, 'conversation');
      }
      listRunning() { return running; }
      deliver(agentId: string, message: string, options: Record<string, unknown>) {
        deliveries.push({ agentId, message, options });
        return Promise.resolve({});
      }
    }
    const ctx = new Context();
    const toolsFiber = ctx.plugin(toolsRow);
    const convFiber = ctx.plugin(ConvStub);
    const diFiber = ctx.plugin(diRow, { backend: 'memory' });
    await Promise.all([toolsFiber, convFiber, diFiber]);
    for (let i = 0; i < 1000; i++) {
      if ((ctx as unknown as Record<string, unknown>).durableInteraction
        && (ctx as unknown as Record<string, unknown>).conversation) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    booted.push({ ctx, fibers: [toolsFiber, convFiber, diFiber] });
    return ctx;
  }

  it('answered 且该会话无活跃 run → conversation.deliver 回投（sender:event）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation([], deliveries); // 无活跃 run（run 已死——重启后场景）
    const rec = ctx.durableInteraction.open({
      key: 'sid-late', kind: 'ask_questions',
      payload: { questions: [{ question: '选哪个？' }] }, owner: 'helper',
    });
    ctx.durableInteraction.reply(rec.id, { answers: ['A'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.agentId).toBe('helper');
    expect(deliveries[0]!.options).toMatchObject({ sender: 'helper', source: 'event', conversationId: 'sid-late' });
    expect(deliveries[0]!.message).toContain('选哪个？');
    expect(deliveries[0]!.message).toContain('A');
  });

  it('run 活跃等待中（正常路径）→ 不回投（工具事件驱动半边自取，防双消费）', async () => {
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const ctx = await bootWithConversation([{ agentId: 'helper', conversationId: 'sid-live' }], deliveries);
    const rec = ctx.durableInteraction.open({
      key: 'sid-live', kind: 'ask_questions',
      payload: { questions: [{ question: 'q' }] }, owner: 'helper',
    });
    ctx.durableInteraction.reply(rec.id, { answers: ['B'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(0);
  });

  it('提权档位留痕与恢复（2026-09-12 反馈：重启后新 run 丢权限→逐工具审批疲劳）', async () => {
    // ① 工具 open 时把 call.elevation 存进 payload（full-access 留痕）
    const { ctx } = await boot({ backend: 'memory' });
    const pending = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-elev-1',
      elevation: 'full-access',
    });
    void pending;
    await new Promise((r) => setTimeout(r, 100));
    const open = ctx.durableInteraction.listOpen({ key: 'helper' })[0];
    expect((open.payload as { elevation?: string }).elevation).toBe('full-access');

    // ② 无提权的 run → payload 无 elevation 字段
    const p2 = exec(ctx, {
      name: 'ask_questions',
      args: { questions: [{ question: 'q2', options: ['x'] }] },
      agentId: 'helper',
      conversationId: 'helper',
      toolCallId: 'call-elev-2',
    });
    void p2;
    await new Promise((r) => setTimeout(r, 100));
    const open2 = ctx.durableInteraction.listOpen({ key: 'helper' }).find((r) => r.correlationId === 'call-elev-2');
    expect((open2!.payload as { elevation?: string }).elevation).toBeUndefined();

    // ③ late-reply 回投：不显式带档位（提权继承由 ac-conversation deliver
    // 边界的会话水位机制统一承担——本行只回投答案，防双路径漂移）
    const deliveries: Array<{ agentId: string; message: string; options: Record<string, unknown> }> = [];
    const { ctx: ctx2 } = await (async () => {
      // 复用 bootWithConversation 需在同 describe——此处内联同款
      const { Service } = await import('@agentchat/cordis');
      class ConvStub extends Service {
        constructor(c: Context) { super(c, 'conversation'); }
        listRunning() { return []; }
        deliver(agentId: string, message: string, options: Record<string, unknown>) {
          deliveries.push({ agentId, message, options });
          return Promise.resolve({});
        }
      }
      const c = new Context();
      const f1 = c.plugin(toolsRow);
      const f2 = c.plugin(ConvStub);
      const f3 = c.plugin(diRow, { backend: 'memory' });
      await Promise.all([f1, f2, f3]);
      booted.push({ ctx: c, fibers: [f1, f2, f3] });
      return { ctx: c };
    })();
    const rec = ctx2.durableInteraction.open({
      key: 'sid-elev', kind: 'ask_questions',
      payload: { questions: [{ question: 'q' }], elevation: 'full-access' }, owner: 'helper',
    });
    ctx2.durableInteraction.reply(rec.id, { answers: ['A'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.options).toMatchObject({ sender: 'helper', source: 'event', conversationId: 'sid-elev' });
    expect(deliveries[0]!.options.elevation).toBeUndefined(); // 不透传——水位继承归 deliver 边界
  });
});
