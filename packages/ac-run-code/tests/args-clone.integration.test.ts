// ============================================================
// ac-run-code：子调用参数侧可克隆防线（cr-1216）——端到端锁定
//   · T1 BigInt 参数：预检拦截，错误含工具名/字段名/自修指引，
//     不再透传 Node 原文 could not be cloned；拒绝后后续子调用照常
//   · T2 嵌套函数参数（对象内）：路径定位到具体字段
//   · T3 循环引用：拒 + 指引
//   · T4 预检残差兜底：getter 抛错的对象（Object.entries 即炸）——
//     postMessage 兜底捕获，错误仍含工具名
//   · T5 干净参数照常执行（回归面）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as agentsRow from 'ac-agents';
import * as diRow from 'ac-durable-interaction';
import * as runCodeRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, llmRow, loopRow, agentsRow, diRow] as unknown[]) {
    fibers.push(await ctx.plugin(row as any));
  }
  ctx.agents.register({ id: 'tester', model: 'm' });
  fibers.push(await ctx.plugin({
    name: 'probe-row',
    inject: ['tools'],
    apply(c: Context) {
      c.tools.register({
        name: 'echo', requiredTags: ['fs'], description: '回声探针',
        parameters: { type: 'object', properties: { text: {} }, required: ['text'] },
        execute: (args) => ({ ok: true, output: { echoed: String((args as Record<string, unknown>).text ?? '') } }),
      });
    },
  } as any));
  fibers.push(await ctx.plugin(runCodeRow as any));
  const entry = { ctx, fibers };
  booted.push(entry);
  return entry;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

function run(ctx: Context, code: string) {
  return ctx.tools.execute({ name: 'run_code', args: { code }, agentId: 'tester', conversationId: 'conv-args', toolCallId: 'tc-args' });
}

describe('ac-run-code：子调用参数可克隆防线（cr-1216）', () => {
  it('T1 BigInt 参数：预检拦截，错误含工具名/字段名/指引——不再透传 Node 原文', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const r = await run(ctx, 'const x = await tools.echo({ text: 5n });\nconst y = await tools.echo({ text: 42 });\nreturn { x, yOk: y.ok };');
    expect(r.ok).toBe(true); // 子调用失败被程序捕获为值，程序本身不炸
    const value = (r.output as { value: { x: { ok: boolean; error: string }; yOk: boolean } }).value;
    expect(value.x.ok).toBe(false);
    expect(value.x.error).toContain('tools.echo 参数 text');
    expect(value.x.error).toContain('BigInt');
    expect(value.x.error).not.toMatch(/could not be cloned/);
    expect(value.yOk).toBe(true); // 拒绝后后续调用照常
  });

  it('T2 嵌套函数参数（对象内）：错误定位到具体字段路径', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const r = await run(ctx, 'return await tools.echo({ text: { inner: () => 1 } });');
    expect(r.ok).toBe(true);
    const value = (r.output as { value: { ok: boolean; error: string } }).value;
    expect(value.ok).toBe(false);
    expect(value.error).toContain('text.inner');
    expect(value.error).toContain('源码串');
  });

  it('T3 循环引用：拒 + 循环引用指引', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const r = await run(ctx, 'const o: Record<string, unknown> = {};\no.self = o;\nreturn await tools.echo({ text: o });');
    expect(r.ok).toBe(true);
    const value = (r.output as { value: { ok: boolean; error: string } }).value;
    expect(value.ok).toBe(false);
    expect(value.error).toContain('循环引用');
  });

  it('T4 预检残差：getter 抛错对象由 postMessage 兜底捕获，错误仍含工具名', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const r = await run(ctx, 'const o = { get text() { throw 0; } };\nreturn await tools.echo({ text: o });');
    expect(r.ok).toBe(true);
    const value = (r.output as { value: { ok: boolean; error: string } }).value;
    expect(value.ok).toBe(false);
    expect(value.error).toContain('tools.echo');
  });

  it('T5 干净参数照常执行（回归面）', { timeout: 15000 }, async () => {
    const { ctx } = await boot();
    const r = await run(ctx, 'return await tools.echo({ text: 7 });');
    expect(r.ok).toBe(true);
    const value = (r.output as { value: { ok: boolean; output?: { echoed: string } } }).value;
    expect(value.ok).toBe(true);
    expect((value.output as { echoed: string }).echoed).toBe('7');
  });
});