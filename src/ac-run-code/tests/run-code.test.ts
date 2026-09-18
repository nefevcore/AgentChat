// ============================================================
// ac-run-code 测试：工具体端到端（真 worker + 真 cordis Context）
// · run_code 注册（infra 标签 + 注册面——2026-09-17 优化：授权随能力族）
// · 基本执行：程序 return → 步记录摘要形态（programHash/value）
// · tools.* 子调用走 ctx.tools.execute（真工具可见）
// · 并发纪律：写路径按提交序串行（时序断言）
// · 递归防护：投影排除 run_code；程序内调用 run_code 被拒
// · import 拒绝 / 类型擦除失败 / 预算 / 中止
// · 复合返回协议：return 优先 / log 回退合成 / 失败附 logsTail
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as runCodeRow from '../src/index.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

interface BootOpts {
  /** 注册进 ctx.tools 的探针工具（默认 echo） */
  probeTools?: boolean;
  /** 预注册 Agent（tags 决定 run_code 可见性） */
  agentTags?: string[];
  /** 带 mock llm provider（投影注入测试用——走到 llm/before-chat） */
  withLlm?: boolean;
}

async function boot(opts: BootOpts = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, agentsRow] as unknown[]) {
    fibers.push(await ctx.plugin(row as any));
  }
  if (opts.agentTags) {
    ctx.agents.register({ id: 'tester', model: 'm', tags: opts.agentTags });
  }
  if (opts.probeTools !== false) {
    // 探针：echo 工具（fs 标签——读侧）
    (globalThis as Record<string, unknown>).__seqLog = [];
    fibers.push(await ctx.plugin({
      name: 'fake-probe-row',
      inject: ['tools'],
      apply(c: Context) {
        c.tools.register({
          name: 'echo',
          requiredTags: ['fs'],
          description: '回声探针',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          execute: (args) => ({ ok: true, output: { echoed: String(args.text ?? '') } }),
        });
      },
    } as any));
  }
  if (opts.withLlm) {
    // mock provider（单步文本收束）+ loop 行——走到 llm/before-chat 才能断言注入
    const rows: unknown[] = [llmRow, {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', () => ({
          stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
            yield { delta: 'ok' };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          },
        }), { models: ['mock-1'] });
      },
    }];
    for (const row of rows) fibers.push(await ctx.plugin(row as any));
    fibers.push(await ctx.plugin(loopRow as any));
  }
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

function call(ctx: Context, code: string, extra: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    name: 'run_code',
    args: { code, ...extra },
    agentId: 'tester',
    conversationId: 'conv-test',
    toolCallId: 'tc-test',
  });
}

/** 慢探针（abort/compute 测试用）：每次执行 30ms */
function fibersSlow(ctx: Context): void {
  ctx.tools.register({
    name: 'slow',
    requiredTags: ['fs'],
    description: '慢探针',
    execute: () => new Promise((r) => setTimeout(() => r({ ok: true, output: { tick: true } }), 30)),
  });
}

describe('ac-run-code：注册与投影', () => {
  it('run_code 注册（requiredTags infra——2026-09-17 优化裁决：授权随能力族，程序化是形态选择）；infra Agent 可见、无标签 Agent 不可见', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    expect(ctx.tools.get('run_code')?.requiredTags).toEqual(['infra']);
    const r = await call(ctx, 'return 1 + 1;');
    expect(r.ok).toBe(true);
    expect((r.output as { value: number }).value).toBe(2);
  });

  it('无 infra 标签 → run_code 不在可见面（resolveEffectiveTools 空投影仍可跑纯计算）', async () => {
    const { ctx } = await boot({ agentTags: [] });
    // 工具仍注册（注册面），但投影空——纯计算程序照常（无需工具）
    const r = await call(ctx, 'return "ok";');
    expect(r.ok).toBe(true);
  });

  it('投影排除 run_code 自身（递归防护）+ include tag 展开随可见面', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, 'return typeof tools.run_code;');
    // 代理 get 抛错 → 程序失败并带明确错误
    expect(r.ok).toBe(false);
    expect((r.output as { error?: string }).error ?? r.error).toMatch(/run_code|递归/);
  });
});

describe('ac-run-code：子调用桥接', () => {
  it('tools.echo 子调用走 ctx.tools.execute（结果回填程序）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const a = await tools.echo({ text: 'hello' });
      return { got: a.output.echoed };
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: { got: string } }).value.got).toBe('hello');
    const summary = (r.output as { summary: { calls: number; ok: number } }).summary;
    expect(summary.calls).toBe(1);
    expect(summary.ok).toBe(1);
  });

  it('时间线 trace：子调用逐条入摘要（卡片数据源——名字/耗时/状态/简述）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const [a, b] = await Promise.all([
        tools.echo({ text: 'x1' }),
        tools.echo({ text: 'x2' }),
      ]);
      return { a: a.output.echoed, b: b.output.echoed };
    `);
    expect(r.ok).toBe(true);
    const s = (r.output as { summary: { trace: Array<{ seq: number; name: string; ok: boolean; ms: number; brief: string }> } }).summary;
    expect(s.trace.length).toBe(2);
    expect(s.trace.every((t) => t.name === 'echo' && t.ok === true && t.ms >= 0)).toBe(true);
    expect(s.trace.some((t) => t.brief.includes('x1'))).toBe(true);
    expect(s.trace.some((t) => t.brief.includes('x2'))).toBe(true);
  });

  it('并发纪律：写路径按提交序串行（真词表工具名命中 WRITE_PATH_TOOLS）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    // 探针注册名 = 'write'（真词表命中——主线程串行链生效）。覆盖实现
    // 而非真实 fs write（单测不落盘；串行判据 = 到达序 == 提交序）
    (globalThis as Record<string, unknown>).__seqLog = [];
    ctx.tools.register({
      name: 'write',
      requiredTags: ['fs'],
      description: '写侧探针（占名真词表）',
      execute: (args) => {
        const log = (globalThis as Record<string, unknown>).__seqLog as number[];
        log.push(Number(args.seq ?? 0));
        return new Promise((r) => setTimeout(() => r({ ok: true, output: { at: log.length } }), Number(args.delay ?? 5)));
      },
    });
    const r = await call(ctx, `
      await Promise.all([
        tools.write({ seq: 1, delay: 30 }),
        tools.write({ seq: 2, delay: 5 }),
        tools.write({ seq: 3, delay: 1 }),
      ]);
      return 'parallel-done';
    `);
    expect(r.ok).toBe(true);
    // 写路径串行：即使 seq2/3 先到（delay 短），执行序仍按提交序 1→2→3
    const log = (globalThis as Record<string, unknown>).__seqLog as number[];
    expect(log).toEqual([1, 2, 3]);
    // 摘要的 serialized 面如实记录（主线程侧判定的串行 seq）
    const summary = (r.output as { summary: { serialized: number[] } }).summary;
    expect(summary.serialized).toEqual([1, 2, 3]);
  });

  it('串行名单单源：WRITE_PATH_TOOLS/COMMAND_TOOLS 从 ac-security import（词表一致性）', async () => {
    const { WRITE_PATH_TOOLS, COMMAND_TOOLS } = await import('ac-security');
    expect([...WRITE_PATH_TOOLS].sort()).toEqual(['edit', 'str_replace_editor', 'write']);
    expect([...COMMAND_TOOLS].sort()).toEqual(['bash', 'pwsh']);
  });

  it('程序体含 import → 拒绝（不执行任何子调用）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `import { x } from 'node:fs';\nreturn x;`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/import|require/);
  });

  // —— 预检收窄（实测复盘 4cd1a90d：四连误杀）——字符串/注释里的词不是模块语义
  it('字符串/注释中含 require 字样 → 不再误杀（pwsh 命令文本、提示注释照常执行）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      // 程序体不允许 require——但注释里提到它不该被拦
      const cmd = "node -e \\"const fs = require('fs');\\"";
      const a = await tools.echo({ text: 'hello' });
      return { cmd, echoed: a.output.echoed };
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: { echoed: string } }).value.echoed).toBe('hello');
  });

  it('模板字面量中的命令文本含 require → 不误杀（base64/脚本拼装场景）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const script = \`const cs = require('vue/compiler-sfc');\`;
      return { len: script.length };
    `);
    expect(r.ok).toBe(true);
  });

  it('真 require 调用仍拒绝，错误带命中位置（可定位）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `const fs = require('node:fs');\nreturn fs;`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/require/);
    expect(r.error).toMatch(/命中位置/);
  });

  it('动态 import() 调用仍拒绝', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `const m = await import('node:fs');\nreturn m;`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/import/);
  });

  it('非可擦除 TS 语法 → 类型擦除失败如实报错', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `enum E { A }\nreturn E.A;`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/类型擦除|可擦除/);
  });

  it('子调用抛错收敛：程序捕获后可继续', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const bad = await tools.echo({ wrong: true });
      return { okFlag: bad.ok, echoed: bad.output?.echoed ?? '(空)' };
    `);
    expect(r.ok).toBe(true); // echo 容错——程序级失败才是 done.ok=false
  });

  it('步记录形态：programHash + summary（程序体全文不入 output）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const body = 'return 42;';
    const r = await call(ctx, body);
    const out = r.output as { programHash: string; summary: unknown; value: number };
    expect(out.programHash).toMatch(/^[0-9a-f]{8}$/);
    expect(out.summary).toBeDefined();
    expect(out.value).toBe(42);
    expect(JSON.stringify(out)).not.toContain('return 42');
  });
});

describe('ac-run-code：SDK 投影注入（实测复盘 #A1/#A2）', () => {
  it('并存形态（tools=[run_code, echo]）：不注入投影块——模型读请求面工具 schema 即可', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'], withLlm: true });
    const calls: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });
    await ctx.agentLoop.run({ agent: 'tester', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], tools: ['run_code', 'echo'] });
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    // 2026-09-17 续修：SDK 投影只在程序化调用（互斥形态）注入——并存
    // 形态传统工具 schema 已在请求面可直读，投影块不进系统提示词
    expect(system?.content ?? '').not.toContain('# run_code 工具 SDK');
  });

  it('无 infra Agent 的 run：不注入（run_code 不在生效面）', async () => {
    const { ctx } = await boot({ agentTags: ['fs'], withLlm: true });
    const calls: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });
    await ctx.agentLoop.run({ agent: 'tester', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], tools: ['echo'] });
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    expect(system?.content ?? '').not.toContain('# run_code 工具 SDK');
  });

  it('真互斥形态（tools=[run_code]，程序化调用）：注入投影块——投影仍含全部授权工具 + 基线纪律', async () => {
    // Agent tools 收窄为仅 run_code（__programmatic__ 预设同构）——LLM 面
    // 只剩 run_code，投影面（能力面直取）仍涵盖 echo 等
    const ctx = new Context();
    const fibers: Fiber[] = [];
    for (const row of [toolsRow, agentsRow] as unknown[]) fibers.push(await ctx.plugin(row as any));
    ctx.agents.register({ id: 'tester', model: 'm', tags: ['fs', 'infra'], tools: ['run_code'] });
    fibers.push(await ctx.plugin({
      name: 'fake-probe-row',
      inject: ['tools'],
      apply(c: Context) {
        c.tools.register({
          name: 'echo', requiredTags: ['fs'], description: '回声探针',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          execute: (args) => ({ ok: true, output: { echoed: String(args.text ?? '') } }),
        });
      },
    } as any));
    const llmRow = await import('ac-llm');
    fibers.push(await ctx.plugin(llmRow as any));
    fibers.push(await ctx.plugin({
      name: 'mock-provider', inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', () => ({
          stream: async function* (): AsyncIterable<LlmStreamChunk> {
            yield { delta: 'ok' };
            yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
          },
        }), { models: ['mock-1'] });
      },
    } as any));
    fibers.push(await ctx.plugin((await import('ac-agent-loop')) as any));
    fibers.push(await ctx.plugin((await import('../src/index.ts')) as any));
    const calls: Array<{ messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
    ctx.on('llm/before-chat', ((payload: { input?: { messages?: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> } }, next: () => Promise<unknown>) => {
      calls.push(payload.input ?? {});
      return next();
    }) as never, { description: '测试探针：截获 LLM 请求面' });
    await ctx.agentLoop.run({ agent: 'tester', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], tools: ['run_code'] });
    const system = calls[0]?.messages?.find((m) => m.role === 'system');
    // 注入存在 + 投影涵盖 echo（能力面直取——include 收窄不影响投影源）
    expect(system?.content ?? '').toContain('# run_code 工具 SDK');
    expect(system?.content ?? '').toContain('echo(args');
    expect(system?.content ?? '').toContain('本会话为程序化模式'); // 互斥形态引导
    // LLM 工具面 = 仅 run_code（loop 的 tools 已是收窄后清单——tools 数组来自 agent.tools 解析）
    const toolNames = (calls[0]?.tools ?? []).map((t) => t.function.name);
    expect(toolNames).toEqual(['run_code']);
    for (const f of fibers) if (f.uid !== null) await f.dispose();
  });
});

describe('ac-run-code：子调用标记（实测复盘 #B）', () => {
  it('子调用 ToolCall 带 runCodeSubcall=true（after-execute 可编程区分）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const seen: Array<{ name: string; subcall: boolean }> = [];
    ctx.on('tool/after-execute', ((call: { name: string; runCodeSubcall?: boolean }) => {
      seen.push({ name: call.name, subcall: call.runCodeSubcall === true });
    }) as never);
    const r = await call(ctx, 'const a = await tools.echo({ text: "x" });\nreturn a.output.echoed;');
    expect(r.ok).toBe(true);
    expect(seen.find((s) => s.name === 'echo')?.subcall).toBe(true); // 子调用带标记
    expect(seen.find((s) => s.name === 'run_code')?.subcall).toBe(false); // 模型直接调用不带
  });
});

describe('ac-run-code：预算与中止', () => {
  it('max_output_bytes 截断（超大返回值标注）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `return 'x'.repeat(10000);`, { max_output_bytes: 1000 });
    expect(r.ok).toBe(true);
    const out = JSON.stringify((r.output as { value: string }).value);
    expect(out.length).toBeLessThan(1300);
  });

  // —— serializeValue 降级链（实测复盘 0d55714a-W1）——出口序列化失败不再整程序失败
  it('return 值含 BigInt/函数 → 降级标注而非程序失败（子调用结果不丢）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const a = await tools.echo({ text: 'kept' });
      return { echoed: a.output?.echoed, big: 123n, fn: () => 1 };
    `);
    expect(r.ok).toBe(true); // 程序成功——不再因序列化失败
    const v = (r.output as { value: Record<string, unknown> }).value;
    expect(v.echoed).toBe('kept'); // 可序列化主体保住
    expect(String(v.big)).toContain('BigInt 123n');
    expect(String(v.__serializeNote)).toMatch(/不可序列化/);
  });

  it('return 循环引用对象 → [Circular] 占位（程序成功 + 标注）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const o: any = { name: 'root' };
      o.self = o;
      return o;
    `);
    expect(r.ok).toBe(true);
    const v = (r.output as { value: Record<string, unknown> }).value;
    expect(v.name).toBe('root');
    expect(JSON.stringify(v)).toMatch(/Circular/);
  });

  it('compute_ms 预算耗尽 → 中止（interrupt 语义）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    fibersSlow(ctx);
    // 每次 30ms：2 次即 60ms > compute_ms=50——第 2 次完成后主线程发 abort
    const r = await call(ctx, `
      for (let i = 0; i < 50; i++) {
        await tools.slow({});
      }
      return 'never';
    `, { compute_ms: 50 });
    expect(r.ok).toBe(false);
    expect((r as { interrupt?: unknown }).interrupt).toBeDefined();
  }, 20000);

  it('用户中止（AbortSignal）→ interrupted + interrupt 载荷', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const ctl = new AbortController();
    const slow = `for (let i = 0; i < 100; i++) { await tools.slow({}); }\nreturn 'done';`;
    // 慢探针：每次 30ms×100 = 3s——150ms 时程序必然在跑
    fibersSlow(ctx);
    setTimeout(() => ctl.abort(), 150);
    const r = await ctx.tools.execute({
      name: 'run_code',
      args: { code: slow },
      agentId: 'tester',
      conversationId: 'conv-test',
      toolCallId: 'tc-abort',
      signal: ctl.signal,
    });
    expect(r.ok).toBe(false);
    expect((r as { interrupt?: { type?: string } }).interrupt?.type).toBe('run-code-interrupted');
  }, 20000);
});

describe('ac-run-code：lib 临时库（会话级复用）', () => {
  it('define → 同程序内可用；resolve 全量清单可见', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      lib.define('clip', (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s));
      const all = lib.resolve() as Record<string, unknown>;
      const clip = lib.resolve('clip') as (s: string) => string;
      return { ok: typeof all.clip === 'function', clipped: clip('abcdef', 3) };
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: { ok: boolean; clipped: string } }).value).toEqual({ ok: true, clipped: 'abc…' });
  });

  it('跨程序复用：程序1 define → 程序2 resolve（经主线程会话级缓存往返）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r1 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('countLines', (t: string) => t.split('\\n').length);\nreturn lib.resolve('countLines')('a\\nb');` },
      agentId: 'tester', conversationId: 'conv-lib', toolCallId: 'tc-lib-1',
    });
    expect(r1.ok).toBe(true);
    // 程序 2：全新 worker——lib 经 init 注入 + 前置求值恢复
    const r2 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `const countLines = lib.resolve('countLines') as (t: string) => number;\nreturn { lines: countLines('x\\ny\\nz') };` },
      agentId: 'tester', conversationId: 'conv-lib', toolCallId: 'tc-lib-2',
    });
    expect(r2.ok).toBe(true);
    expect((r2.output as { value: { lines: number } }).value.lines).toBe(3);
  });

  it('自由变量：库引用外部变量 → 调用期 ReferenceError（函数体惰性——define 期不触发）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    // 形态 1：函数直传（toString 后 LIMIT 悬空——调用期爆）
    const r = await call(ctx, `
      const LIMIT = 80;
      lib.define('bad', (s: string) => s.slice(0, LIMIT)); // 惰性——注册成功
      try {
        const bad = lib.resolve('bad') as (s: string) => string;
        bad('abcdef');
        return 'unexpected-called';
      } catch (e) {
        return /LIMIT/.test(String(e)) ? 'caught-limit' : String(e);
      }
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: string }).value).toBe('caught-limit');
    // 形态 2：程序体字符串 return 一个闭包函数——同样惰性（求值只造函数不执行体）
    const r2 = await call(ctx, `
      lib.define('bad2', "const f = (s) => s.slice(0, OUTER_N);\\nreturn f;");
      try {
        const f = lib.resolve('bad2') as (s: string) => string;
        f('x');
        return 'unexpected-called-2';
      } catch (e) {
        return /OUTER_N/.test(String(e)) ? 'caught-outer' : String(e);
      }
    `);
    expect(r2.ok).toBe(true);
    expect((r2.output as { value: string }).value).toBe('caught-outer');
    // 形态 3：程序体顶层即用外部变量（非函数包裹）——急切求值，define 期即拒
    const r3 = await call(ctx, `
      try {
        lib.define('bad3', "return OUTER_NOW;");
        return 'unexpected-registered';
      } catch (e) { return /自包含|求值失败/.test(String(e)) ? 'caught-contained' : String(e); }
    `);
    expect(r3.ok).toBe(true);
    expect((r3.output as { value: string }).value).toBe('caught-contained');
  });

  it('lib 源码预检：程序体字符串形态藏 require → define 拒绝（防借道注入）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      try {
        const evilSrc = ["const fs = require", String.fromCharCode(40,39) + "node:fs" + String.fromCharCode(39,41) + ";", "return fs;"].join(String.fromCharCode(10));
        lib.define('evil', evilSrc);
        return 'unexpected-registered';
      } catch (e) {
        return String(e);
      }
    `);
    expect(r.ok, "run fail: " + (r.error ?? "")).toBe(true);
    expect((r.output as { value: string }).value).toMatch(/库源码不允许/);
  });

  it('resolve 未注册 → 报错附可用名单', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      try { lib.resolve('nope'); return 'unexpected'; } catch (e) { return String(e); }
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: string }).value).toMatch(/nope 未注册/);
  });

  it('失败程序不回写注册表：define 后抛错 → 库不残留（下次 resolve 报未注册）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r1 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('doomed', () => 1);\nthrow new Error('boom');` },
      agentId: 'tester', conversationId: 'conv-lib2', toolCallId: 'tc-doom-1',
    });
    expect(r1.ok).toBe(false);
    const r2 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `try { lib.resolve('doomed'); return 'unexpected'; } catch (e) { return String(e); }` },
      agentId: 'tester', conversationId: 'conv-lib2', toolCallId: 'tc-doom-2',
    });
    expect(r2.ok).toBe(true);
    expect((r2.output as { value: string }).value).toMatch(/doomed 未注册/);
  });

  it('同会话累积 + 覆盖：程序2 define 新库 → 程序3 两库并存；重名覆盖', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('a', () => 'A1');\nreturn 1;` },
      agentId: 'tester', conversationId: 'conv-lib3', toolCallId: 'tc-acc-1',
    });
    await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('b', () => 'B');\nreturn 1;` },
      agentId: 'tester', conversationId: 'conv-lib3', toolCallId: 'tc-acc-2',
    });
    const r3 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `const a = lib.resolve('a') as () => string;\nconst b = lib.resolve('b') as () => string;\nlib.define('a', () => 'A2');\nconst a2 = lib.resolve('a') as () => string;\nreturn { a: a(), b: b(), a2: a2() };` },
      agentId: 'tester', conversationId: 'conv-lib3', toolCallId: 'tc-acc-3',
    });
    expect(r3.ok).toBe(true);
    expect((r3.output as { value: { a: string; b: string; a2: string } }).value).toEqual({ a: 'A1', b: 'B', a2: 'A2' });
  });

  it('库函数内调工具：async 库经 tools 桥（子调用计数入 summary）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('shout', async (t: string) => { const r = await tools.echo({ text: t }); return (r.output as { echoed: string }).echoed.toUpperCase(); });\nreturn 1;` },
      agentId: 'tester', conversationId: 'conv-lib4', toolCallId: 'tc-tool-1',
    });
    const r2 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `const shout = lib.resolve('shout') as (t: string) => Promise<string>;\nreturn { got: await shout('hi') };` },
      agentId: 'tester', conversationId: 'conv-lib4', toolCallId: 'tc-tool-2',
    });
    expect(r2.ok).toBe(true);
    expect((r2.output as { value: { got: string } }).value.got).toBe('HI');
    const summary = (r2.output as { summary: { calls: number } }).summary;
    expect(summary.calls).toBe(1); // echo 子调用经桥——计数照走
  });

  it('命名空间隔离：不同 conversation 的注册表互不可见', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('onlyHere', () => 1);\nreturn 1;` },
      agentId: 'tester', conversationId: 'conv-x', toolCallId: 'tc-ns-1',
    });
    const r = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `try { lib.resolve('onlyHere'); return 'unexpected'; } catch (e) { return String(e); }` },
      agentId: 'tester', conversationId: 'conv-y', toolCallId: 'tc-ns-2',
    });
    expect(r.ok).toBe(true);
    expect((r.output as { value: string }).value).toMatch(/onlyHere 未注册/);
  });
});

describe('ac-run-code：复合返回协议（return / log）', () => {
  it('return 有值 → valueVia=return（log 存在也不回流）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, "log('中途');\nreturn { sum: 42 }");
    expect(r.ok).toBe(true);
    const out = r.output as { value: unknown; valueVia: string; logsTail?: string[] };
    expect(out.valueVia).toBe('return');
    expect((out.value as { sum: number }).sum).toBe(42);
    expect(out.logsTail).toBeUndefined();
  });

  it('无 return 值有 log → valueVia=logs，各行按序合成', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, "log('第一条：a=1');\nlog('第二条：b=2');");
    expect(r.ok).toBe(true);
    const out = r.output as { value: string; valueVia: string };
    expect(out.valueVia).toBe('logs');
    expect(out.value).toBe('第一条：a=1\n第二条：b=2');
  });

  it('无 return 无 log → ok 无 value（旧协议兼容）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, 'const x = 1;');
    expect(r.ok).toBe(true);
    expect((r.output as { value?: unknown }).value).toBeUndefined();
  });

  it('对象 log 参数 JSON 序列化混排', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, "log('结果', { ok: 1, list: ['a'] });");
    const out = r.output as { value: string; valueVia: string };
    expect(out.valueVia).toBe('logs');
    expect(out.value).toContain('{"ok":1,"list":["a"]}');
  });

  it('失败程序：logsTail = 末 5 条（诊断线索，value 缺席）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const code = [
      "log('step1 ok');",
      "log('step2 ok');",
      "log('step3 ok');",
      "throw new Error('boom');",
    ].join('\n');
    const r = await call(ctx, code);
    expect(r.ok).toBe(false);
    expect((r.output as { logsTail?: string[] }).logsTail).toEqual(['step1 ok', 'step2 ok', 'step3 ok']);
    expect((r.output as { value?: unknown }).value).toBeUndefined();
  });

  it('log 条目超限（>500）：丢弃计数标注在合成值尾部', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, "for (let i = 0; i < 503; i++) log('行' + i);");
    expect(r.ok).toBe(true);
    const out = r.output as { value: string; valueVia: string };
    expect(out.valueVia).toBe('logs');
    expect(out.value).toContain('行499');
    expect(out.value).toContain('丢弃 3 条');
  });
});
