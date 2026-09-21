// ============================================================
// ac-run-code 预算冻结测试（2026-09-23 墙钟唯一化收敛后口径）
//
// 机制：本 run 挂起 durable-interaction（approval 等——correlationId=
// 子调用 toolCallId 落盘）期间，墙钟看门狗暂停。预算约束机器时间，人的
// 应答时间不是机器时间。compute 轴已退役（等待型子调用烧 compute 的整类
// 问题随轴消失）；墙钟是唯一时间防线（宿主行配置单源，程序入参不可见）。
//   · T1 无交互挂起时墙钟照杀（slow 子调用累计超墙钟即中止）
//   · T2 冻结期墙钟暂停：挂起 400ms 超墙钟 150ms，应答后程序存活
//   · T3 冻结只圈本 run：他 run 的挂起交互不豁免本 run 墙钟
//   · T4 用户中止传播：abort 直达 worker（含物理 terminate），run 收束
//   · T5 墙钟冻结：挂起 500ms > 墙钟 400ms，看门狗暂停不杀
//   · T6 长等待子调用直吃墙钟（send_agent wait 超时不再被 compute 误杀
//     的对照面：墙钟兜底即正确行为——被杀说明防线在工作）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as diRow from 'ac-durable-interaction';
import * as runCodeRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

/** boot（墙钟上限经行配置——宿主侧单源；缺省走 DEFAULTS 720s） */
async function boot(maxWallMs?: number) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, agentsRow, diRow] as unknown[]) {
    fibers.push(await ctx.plugin(row as any));
  }
  ctx.agents.register({ id: 'tester', model: 'm', tags: ['fs', 'infra'] });
  // 探针：echo（即回）+ slow（30ms——墙钟测试的耗时源）+ hang（挂起
  // 在 durable-interaction 上等人应答——冻结机制的载体）+ waitpeer（长等待，
  // 模拟 send_agent wait 对端 run 在途）
  fibers.push(await ctx.plugin({
    name: 'fake-probe-row',
    inject: ['tools', 'durableInteraction'],
    apply(c: Context) {
      c.tools.register({
        name: 'echo', requiredTags: ['fs'], description: '回声探针',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (args) => ({ ok: true, output: { echoed: String(args.text ?? '') } }),
      });
      c.tools.register({
        name: 'slow', requiredTags: ['fs'], description: '慢探针（30ms）',
        parameters: { type: 'object', properties: {} },
        execute: () => new Promise((res) => setTimeout(() => res({ ok: true, output: { tick: true } }), 30)),
      });
      c.tools.register({
        name: 'waitpeer', requiredTags: ['fs'], description: '长等待探针（sleep——模拟等对端 run）',
        parameters: { type: 'object', properties: { ms: { type: 'number' } } },
        execute: (args) => new Promise((res) => setTimeout(() => res({ ok: true, output: { waited: Number(args.ms ?? 400) } }), Number(args.ms ?? 400))),
      });
      c.tools.register({
        name: 'hang', requiredTags: ['fs'], description: '挂起探针（open 后等 replied/closed）',
        parameters: { type: 'object', properties: {} },
        execute: (_args, call) => new Promise((resolve) => {
          const conv = String(call.conversationId ?? call.agentId ?? 'conv-frz');
          const rec = c.durableInteraction.open({
            key: conv, kind: 'approval', payload: {},
            ...(call.toolCallId !== undefined ? { correlationId: call.toolCallId } : {}),
            ...(call.agentId !== undefined ? { owner: String(call.agentId) } : {}),
          });
          const done = () => {
            disposeReplied();
            disposeClosed();
            clearInterval(poller);
            call.signal?.removeEventListener('abort', onAbort);
            resolve({ ok: true, output: { interaction_id: rec.id } });
          };
          const onEvt = (r: { id: string }) => { if (r.id === rec.id) done(); };
          const onAbort = () => { c.durableInteraction.close(rec.id, 'aborted'); };
          const disposeReplied = c.on('durable-interaction/replied', onEvt, { description: 'hang 探针' });
          const disposeClosed = c.on('durable-interaction/closed', onEvt, { description: 'hang 探针' });
          const poller = setInterval(() => {
            const cur = c.durableInteraction.get(rec.id);
            if (cur && cur.state !== 'pending') done();
            if (call.signal?.aborted) done();
          }, 30);
          call.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      });
    },
  } as any));
  fibers.push(await ctx.plugin(runCodeRow as any, maxWallMs !== undefined ? { defaultMaxWallMs: maxWallMs } : {}));
  const entry = { ctx, fibers };
  booted.push(entry);
  return entry;
}

afterEach(async () => {
  for (const { ctx, fibers } of booted.splice(0)) {
    try {
      for (const rec of ctx.durableInteraction.listOpen()) ctx.durableInteraction.close(rec.id, 'test-end');
    } catch { /* 行缺席 */ }
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

function run(ctx: Context, code: string, toolCallId = 'tc-frz', signal?: AbortSignal) {
  return ctx.tools.execute({
    name: 'run_code',
    args: { code },
    agentId: 'tester',
    conversationId: 'conv-frz',
    toolCallId,
    ...(signal ? { signal } : {}),
  });
}

/** 等待本会话出现挂起的 approval 交互（hang 探针载体） */
async function hangOpened(ctx: Context, timeoutMs = 3000): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = ctx.durableInteraction.listOpen({ key: 'conv-frz' }).find((r) => r.kind === 'approval');
    if (open) return open;
    if (Date.now() > deadline) throw new Error('approval 交互未出现（超时）');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ac-run-code：预算冻结（durable-interaction 挂起期不计预算）', () => {
  it('T1 无交互挂起时墙钟照杀（slow 子调用累计超墙钟即中止——墙钟唯一防线口径）', { timeout: 15000 }, async () => {
    const { ctx } = await boot(150);
    const r = await run(ctx, ''
      + 'for (let i = 0; i < 20; i++) await tools.slow({});' + '\n'
      + 'return { done: true };',
    );
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/墙钟预算耗尽/);
  });

  it('T2 冻结期墙钟暂停：挂起 400ms 超墙钟 150ms，应答后程序存活', { timeout: 15000 }, async () => {
    const { ctx } = await boot(150);
    const pending = run(ctx, ''
      + 'const r = await tools.hang({});' + '\n'
      + 'return { ok: r.ok };',
    );
    const open = await hangOpened(ctx);
    await sleep(400); // 无冻结时：hang dur(≥400ms) > 150ms → 应答即杀
    ctx.durableInteraction.reply(open.id, { approved: true });
    const r = await pending;
    expect(r.ok).toBe(true);
    const value = (r.output as { value: { ok: boolean } }).value;
    expect(value.ok).toBe(true);
    // 墙钟断言：frozenMs 剔除后有效墙钟远小于 150ms（看门狗暂停生效）
    const summary = (r.output as { summary: { wallMs: number; frozenMs?: number } }).summary;
    expect(summary.wallMs).toBeGreaterThanOrEqual(400);
    expect(summary.frozenMs ?? 0).toBeGreaterThanOrEqual(390);
  });

  it('T3 冻结只圈本 run：他 run 的挂起交互（correlationId 前缀不同）不豁免本 run 墙钟', { timeout: 15000 }, async () => {
    const { ctx } = await boot(150);
    // run A（tc-wait）：挂一个无人应答的交互（保持 pending）
    const runA = run(ctx, 'const a = await tools.hang({});\nreturn { ok: a.ok };', 'tc-wait');
    await hangOpened(ctx);
    // run B（tc-frz）：slow 烧墙钟超限——A 的挂起（tc-wait# 前缀）不豁免 B
    const rB = await run(ctx, ''
      + 'for (let i = 0; i < 20; i++) await tools.slow({});' + '\n'
      + 'return { done: true };',
    );
    expect(rB.ok).toBe(false);
    expect(rB.error ?? '').toMatch(/墙钟预算耗尽/);
    void runA; // 保持引用（收尾由 afterEach 清）
  });

  it('T4 用户中止传播：abort 直达 worker（物理 terminate），run 以中止收束', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const ac = new AbortController();
    const pending = run(ctx, ''
      + 'const r = await tools.hang({});' + '\n'
      + 'return { got: r.ok };',
      'tc-frz', ac.signal,
    );
    const open = await hangOpened(ctx);
    await sleep(50);
    ac.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/中止/);
    await sleep(100);
    const rec = ctx.durableInteraction.get(open.id);
    expect(rec?.state).toBe('closed');
  });

  it('T5 墙钟冻结：挂起等待 500ms > 墙钟 400ms，看门狗暂停不杀；应答后按剩余续跑', { timeout: 15000 }, async () => {
    const { ctx } = await boot(400);
    const pending = run(ctx, ''
      + 'const r = await tools.hang({});' + '\n'
      + 'return { ok: r.ok };',
    );
    const open = await hangOpened(ctx);
    await sleep(500); // 无冻结时：500ms > 400ms → 看门狗杀
    ctx.durableInteraction.reply(open.id, { approved: true });
    const r = await pending;
    expect(r.ok).toBe(true); // 冻结期看门狗暂停——未杀
  });

  it('T6 长等待子调用直吃墙钟：超墙钟即被杀（等待型子调用不再有 compute 豁免——墙钟兜底即正确行为）', { timeout: 15000 }, async () => {
    const { ctx } = await boot(300);
    const r = await run(ctx, ''
      + 'const r = await tools.waitpeer({ ms: 600 });' + '\n'
      + 'return { ok: r.ok };',
    );
    // 墙钟 300ms < 等待 600ms → 程序被杀（防线在工作；实际使用中 run_code 墙钟
    // 720s，send_agent wait 有自己的 timeout_ms 语法糖先行返回）
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/墙钟预算耗尽/);
  });
});
