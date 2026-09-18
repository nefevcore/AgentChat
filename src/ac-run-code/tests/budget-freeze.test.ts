// ============================================================
// ac-run-code 预算冻结测试（2026-09-22 机制落地）
//
// 机制：本 run 子调用挂起 durable-interaction（ask_questions/approval
// ——correlationId=子调用 toolCallId 落盘）期间，墙钟看门狗暂停、子调用
// 计费剔除冻结区间。预算约束机器时间，人的应答时间不是机器时间。
//   · T1 无交互挂起时 compute 预算照杀（slow 探针烧子调用耗时）
//   · T2 ask 等待期不计 compute：等待 400ms 超预算 150ms 仍存活
//   · T3 冻结只圈本 run：他 run 挂起交互（前缀不同）不豁免本 run 预算
//   · T4 用户中止传播：在飞 ask_questions 收到 abort → close('aborted')
//     （signal 预创建修复——旧代码 abort 传不进在飞等待型工具）
//   · T5 墙钟冻结：ask 等待 500ms > maxWallMs 400，看门狗暂停不杀
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as diRow from 'ac-durable-interaction';
import * as askRow from 'ac-ask-questions';
import * as runCodeRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, agentsRow, diRow, askRow] as unknown[]) {
    fibers.push(await ctx.plugin(row as any));
  }
  ctx.agents.register({ id: 'tester', model: 'm', tags: ['fs', 'infra'] });
  // 探针：echo（即回）+ slow（30ms——compute 预算测试的耗时源）
  fibers.push(await ctx.plugin({
    name: 'fake-probe-row',
    inject: ['tools'],
    apply(c: Context) {
      c.tools.register({
        name: 'echo', requiredTags: ['fs'], description: '回声探针',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (args) => ({ ok: true, output: { echoed: String(args.text ?? '') } }),
      });
      c.tools.register({
        name: 'slow', requiredTags: ['fs'], description: '慢探针（30ms）',
        execute: () => new Promise((res) => setTimeout(() => res({ ok: true, output: { tick: true } }), 30)),
      });
    },
  } as any));
  fibers.push(await ctx.plugin(runCodeRow as any));
  const entry = { ctx, fibers };
  booted.push(entry);
  return entry;
}

afterEach(async () => {
  for (const { ctx, fibers } of booted.splice(0)) {
    // 收尾悬空交互（防泄漏 run 的等待工具永远挂起——测试进程干净退出）
    try {
      for (const rec of ctx.durableInteraction.listOpen()) ctx.durableInteraction.close(rec.id, 'test-end');
    } catch { /* 行缺席 */ }
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

function run(ctx: Context, code: string, extra: Record<string, unknown> = {}, toolCallId = 'tc-frz', signal?: AbortSignal) {
  return ctx.tools.execute({
    name: 'run_code',
    args: { code, ...extra },
    agentId: 'tester',
    conversationId: 'conv-frz',
    toolCallId,
    ...(signal ? { signal } : {}),
  });
}

/** 等待本会话出现挂起的 ask_questions 交互 */
async function askOpened(ctx: Context, timeoutMs = 3000): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = ctx.durableInteraction.listOpen({ key: 'conv-frz' }).find((r) => r.kind === 'ask_questions');
    if (open) return open;
    if (Date.now() > deadline) throw new Error('ask_questions 交互未出现（超时）');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ac-run-code：预算冻结（ask_questions 等待期不计预算）', () => {
  it('T1 无交互挂起时 compute 预算照杀（slow 子调用累计超限即中止）', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const r = await run(ctx, `
      for (let i = 0; i < 20; i++) await tools.slow({});
      return { done: true };
    `, { compute_ms: 150 });
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/超预算/);
  });

  it('T2 ask 等待期不计 compute：等待 400ms 超预算 150ms，应答后程序存活且计费剔除冻结区间', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const pending = run(ctx, `
      const r = await tools.ask_questions({ questions: [{ question: '等待期豁免？', options: ['是', '否'] }] });
      return { ok: r.ok, ans: r.output?.answers };
    `, { compute_ms: 150 });
    const open = await askOpened(ctx);
    await sleep(400); // 无冻结时：ask dur(≥400ms) > 150ms → 答复即杀
    ctx.durableInteraction.reply(open.id, ['是']);
    const r = await pending;
    expect(r.ok).toBe(true);
    const value = (r.output as { value: { ok: boolean; ans: string[] } }).value;
    expect(value.ok).toBe(true);
    expect(value.ans).toEqual(['是']);
    // 计费断言：computeUsed 剔除了冻结区间（远小于墙钟）
    const summary = (r.output as { summary: { computeMs: number; wallMs: number } }).summary;
    expect(summary.wallMs).toBeGreaterThanOrEqual(400);
    expect(summary.computeMs).toBeLessThan(150 + 50); // 冻结区间外只剩毫秒级开销
  });

  it('T3 冻结只圈本 run：他 run 的挂起交互（correlationId 前缀不同）不豁免本 run 预算', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    // run A（tc-wait）：挂一个无人应答的 ask（保持 pending）
    const runA = run(ctx, `const a = await tools.ask_questions({ questions: [{ question: '挂着', options: ['A', 'B'] }] });\nreturn { askOk: a.ok };`, {}, 'tc-wait');
    await askOpened(ctx);
    // run B（tc-frz）：slow 烧 compute 超预算——A 的挂起（tc-wait# 前缀）不豁免 B
    const rB = await run(ctx, `
      for (let i = 0; i < 20; i++) await tools.slow({});
      return { done: true };
    `, { compute_ms: 150 });
    expect(rB.ok).toBe(false);
    expect(rB.error ?? '').toMatch(/超预算/);
    // 收尾 run A
    const open = ctx.durableInteraction.listOpen({ key: 'conv-frz' }).find((x) => x.kind === 'ask_questions');
    expect(open).toBeTruthy();
    ctx.durableInteraction.close(open!.id, 'test-done');
    const rA = await runA;
    // 交互被关闭 → ask 工具以失败收束（非悬空）；程序本身可正常 return
    expect(rA.ok).toBe(true);
    expect((rA.output as { value: { askOk: boolean } }).value.askOk).toBe(false);
  });

  it('T4 用户中止传播：在飞 ask_questions 收到 abort → close(aborted)，run 以中止收束（signal 预创建修复）', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const ac = new AbortController();
    const pending = run(ctx, `
      const r = await tools.ask_questions({ questions: [{ question: '中止测试', options: ['A', 'B'] }] });
      return { got: r.ok };
    `, {}, 'tc-frz', ac.signal);
    const open = await askOpened(ctx);
    await sleep(50);
    ac.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/中止/);
    await sleep(100);
    // 关键断言：交互被 ask 工具干净关闭（旧 bug：signal 拿不到 → 悬空 pending）
    expect(ctx.durableInteraction.listOpen({ key: 'conv-frz' }).length).toBe(0);
    const rec = ctx.durableInteraction.get(open.id);
    expect(rec?.state).toBe('closed');
    expect(rec?.closedReason).toBe('aborted');
  });

  it('T5 墙钟冻结：ask 等待 500ms > maxWallMs 400，看门狗暂停不杀；应答后按剩余续跑', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const pending = run(ctx, `
      const r = await tools.ask_questions({ questions: [{ question: '看门狗暂停？', options: ['A', 'B'] }] });
      return { ok: r.ok };
    `, { max_wall_ms: 400 });
    const open = await askOpened(ctx);
    await sleep(500); // 无冻结时：400ms 看门狗在挂起中点火 → 硬杀
    ctx.durableInteraction.reply(open.id, ['A']);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect((r.output as { value: { ok: boolean } }).value.ok).toBe(true);
    expect(ctx.durableInteraction.get(open.id)?.state).toBe('answered');
  });
});
