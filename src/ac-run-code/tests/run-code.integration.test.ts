// ============================================================
// ac-run-code 测试：工具体端到端（真 worker + 真 cordis Context）
// · run_code 注册（injection:'mode'——2026-12 注入轴：不挂标签，模式合成）
// · 基本执行：程序 return → 步记录摘要形态（programHash/value）
// · tools.* 子调用走 ctx.tools.execute（真工具可见）
// · 并发纪律：写路径按提交序串行（时序断言）
// · 递归防护：投影排除 run_code；程序内调用 run_code 被拒
// · import 拒绝 / 类型擦除失败 / 预算 / 中止
// · 复合返回协议：return 优先 / log 回退合成 / 失败附 logsTail
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
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
  /** 预注册 Agent（tags 决定常规工具可见面——run_code 为 mode 工具与 tags 无关） */
  agentTags?: string[];
  /** 带 mock llm provider（投影注入测试用——走到 llm/before-chat） */
  withLlm?: boolean;
  /** 墙钟上限（行配置——2026-09-23 墙钟唯一化后预算的唯一入口） */
  wallMs?: number;
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
  fibers.push(await ctx.plugin(runCodeRow as any, opts.wallMs !== undefined ? { defaultMaxWallMs: opts.wallMs } : {}));
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
  it('run_code 注册（injection mode——2026-12 注入轴：不挂 requiredTags、不进常规工具面）；任何 Agent 可执行（直调）', async () => {
    const { ctx } = await boot({ agentTags: ['fs'] });
    expect(ctx.tools.get('run_code')?.injection).toBe('mode');
    expect(ctx.tools.get('run_code')?.requiredTags).toBeUndefined();
    const r = await call(ctx, 'return 1 + 1;');
    expect(r.ok).toBe(true);
    expect((r.output as { value: number }).value).toBe(2);
  });

  it('无任何标签 → 空投影仍可跑纯计算（run_code 与 tags 无关——mode 通道）', async () => {
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
  it('模板串内嵌反引号 → 擦除失败错误带修复提示（转义税治理）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, 'const s = `用 `pwsh` 执行`;\nreturn s;');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/类型擦除/);
    expect(r.error).toMatch(/反引号|join/);
  });

  it('转义反引号后同形程序可执行（正解自证）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, 'const s = `用 \\`pwsh\\` 执行`;\nreturn s;');
    expect(r.ok).toBe(true);
    expect((r.output as { value: string }).value).toBe('用 `pwsh` 执行');
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

  it('墙钟预算耗尽 → 中止（interrupt 语义——2026-09-23 compute 退役后唯一预算口径）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'], wallMs: 50 });
    fibersSlow(ctx);
    // 每次 30ms：2 次即 60ms > 墙钟 50ms——看门狗到期杀程序
    const r = await call(ctx, `
      for (let i = 0; i < 50; i++) {
        await tools.slow({});
      }
      return 'never';
    `, {});
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
  it('define → 同程序内可用；resolve() 清单为纯静态摘要（立项③-A 语义）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      lib.define('clip', (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s));
      const all = lib.resolve() as Record<string, { kind: string; preview: string }>;
      const clip = lib.resolve('clip') as (s: string) => string;
      return { ok: all.clip.kind === 'function' && all.clip.preview.includes('slice'), clipped: clip('abcdef', 3) };
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

  it('Ⓐ（2026-11-19 追记）define 传对象 → 即时指引（数据本体无法跨程序注册）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      try {
        lib.define('badobj', { a: 1, b: [2, 3] });
        return 'unexpected-registered';
      } catch (e) { return String(e); }
    `);
    expect(r.ok, "run fail: " + (r.error ?? "")).toBe(true);
    const v = String((r.output as { value: string }).value);
    expect(v).toMatch(/对象/);
    expect(v).toMatch(/正确示例|源码字符串/);
  });

  it('（9eaf3f03 复盘 ①）匿名函数源码串：函数表达式形态 strip 成立——不再 Expected ident', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      lib.define('patch', \"async function (fp, os, ns) { return { fp, os, ns }; }\");
      const patch = lib.resolve('patch') as (fp: string, os: string, ns: string) => Promise<{ fp: string; os: string; ns: string }>;
      return { called: await patch('a', 'b', 'c') };
    `);
    expect(r.ok, 'run fail: ' + (r.error ?? '')).toBe(true);
    expect((r.output as { value: { called: { fp: string } } }).value.called).toEqual({ fp: 'a', os: 'b', ns: 'c' });
  });

  it('（9eaf3f03 复盘 ②）resolve 单名返回本体：直接调用成立、解构 undefined 为反模式', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      lib.define('add', (a: number, b: number) => a + b);
      const direct = lib.resolve('add') as (a: number, b: number) => number;
      const destructure = { ...({} as Record<string, never>) };
      return { via: direct(2, 3), isFn: typeof direct === 'function' };
    `);
    expect(r.ok, 'run fail: ' + (r.error ?? '')).toBe(true);
    const v = r.output as { value: { via: number; isFn: boolean } };
    expect(v.value).toEqual({ via: 5, isFn: true });
  });

  it('（9eaf3f03 复盘 ③④）失败收束报错附本程序 define 丢弃清单', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r1 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `lib.define('patchFile', () => 1);\nlib.define('readSeg', () => 2);\nthrow new Error('boom');` },
      agentId: 'tester', conversationId: 'conv-lib-drop', toolCallId: 'tc-drop-1',
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/patchFile、readSeg 已随失败丢弃/);
    // 注册表确认不残留（回滚语义保持）
    const r2 = await ctx.tools.execute({
      name: 'run_code',
      args: { code: `try { lib.resolve('patchFile'); return 'unexpected'; } catch (e) { return String(e); }` },
      agentId: 'tester', conversationId: 'conv-lib-drop', toolCallId: 'tc-drop-2',
    });
    expect(r2.ok).toBe(true);
    expect((r2.output as { value: string }).value).toMatch(/patchFile 未注册/);
  });

  it('（9eaf3f03 复盘）程序体形态含 await：报错附针对性指引（async 函数形态正解）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      try { lib.define('bad', "const r = await tools.read({ file_path: 'x' }); return 1;"); return 'unexpected'; }
      catch (e) { return String(e); }
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: string }).value).toMatch(/async 函数形态/);
  });

  it('lib DX 增强（2026-11-19）：直调糖——lib.<名> 与 resolve 同通道同结果', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      lib.define('add', (a, b) => a + b);
      const viaDirect = lib.add(1, 2);
      const viaResolve = lib.resolve('add')(1, 2);
      return { viaDirect, viaResolve };
    `);
    expect(r.ok, "run fail: " + (r.error ?? "")).toBe(true);
    const v = r.output as { value: { viaDirect: number; viaResolve: number } };
    expect(v.value.viaDirect).toBe(3);
    expect(v.value.viaResolve).toBe(3);
  });

  it('lib DX 增强：函数体引用外围变量 → define 返回 warning（防「测试时好、复用时炸」陷阱）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const OUTER_LIMIT = 3;  // 外围变量——fn.toString() 带不走闭包环境
      const reg = lib.define('trap', (s) => s.slice(0, OUTER_LIMIT));
      return { warned: reg.warning ?? 'none' };
    `);
    expect(r.ok).toBe(true);
    const v = String((r.output as { value: { warned: string } }).value.warned);
    expect(v).toMatch(/OUTER_LIMIT/);
    expect(v).toMatch(/ReferenceError/);
  });

  it('lib DX 增强：自包含函数定义零告警（告警不误伤正常路径）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const reg = lib.define('clean', (s) => '[' + s + ']');
      return { warned: reg.warning ?? 'none' };
    `);
    expect(r.ok).toBe(true);
    expect((r.output as { value: { warned: string } }).value.warned).toBe('none');
  });

  it('lib DX 增强：保留名穿透（then/define/resolve 不入注册表查询）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      const thenUndefined = lib.then === undefined;
      const defineIsFn = typeof lib.define === 'function';
      return { thenUndefined, defineIsFn };
    `);
    expect(r.ok).toBe(true);
    const v = (r.output as { value: { thenUndefined: boolean; defineIsFn: boolean } }).value;
    expect(v.thenUndefined).toBe(true);   // Promise 探测不误炸
    expect(v.defineIsFn).toBe(true);      // 方法面照常
  });

  it('lib DX 增强：未注册名直调 → 带指引的错误（不再裸 TypeError）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      try { lib.nope(1); return 'unexpected'; } catch (e) { return String(e); }
    `);
    expect(r.ok).toBe(true);
    const v = String((r.output as { value: string }).value);
    expect(v).toMatch(/nope 未注册/);
    expect(v).toMatch(/lib\.define|resolve/); // 指引在场
  });

  it('Ⓐ（2026-11-19 追记）define 传数字 → 即时指引', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, `
      try {
        lib.define('badnum', 42);
        return 'unexpected-registered';
      } catch (e) { return String(e); }
    `);
    expect(r.ok).toBe(true);
    const v = String((r.output as { value: string }).value);
    expect(v).toMatch(/number|正确示例/);
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

  it('无 return 值（隐式 undefined）有 log → valueVia=logs，各行按序合成', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, "log('第一条：a=1');\nlog('第二条：b=2');");
    expect(r.ok).toBe(true);
    const out = r.output as { value: string; valueVia: string };
    expect(out.valueVia).toBe('logs');
    expect(out.value).toBe('第一条：a=1\n第二条：b=2');
  });

  it('return null → 视为无值，log 各行按序合成（valueVia=logs）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, "log('via-log');\nreturn null;");
    expect(r.ok).toBe(true);
    const out = r.output as { value: string; valueVia: string };
    expect(out.valueVia).toBe('logs');
    expect(out.value).toBe('via-log');
  });

  it('return null 无 log → ok 无 value（同 undefined 旧协议兼容）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, 'return null;');
    expect(r.ok).toBe(true);
    expect((r.output as { value?: unknown }).value).toBeUndefined();
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

// ============================================================
// 立项①③验收（run-code-hardening-backlog）：worker 防退化护栏 + lib 注册表自愈
// ============================================================
describe('ac-run-code：立项① 引导护栏（快照回退基建）', () => {
  it('成功 run 刷新进程内快照（下次 run 引导链有回退目标）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    runCodeRow.__runCodeTestHooks.setMemSnapshot(null);
    const r = await call(ctx, 'return 1 + 1;');
    expect(r.ok, r.error ?? '').toBe(true);
    const snap = runCodeRow.__runCodeTestHooks.getMemSnapshot();
    expect(snap).not.toBeNull();
    expect(String(snap)).toContain('worker_threads'); // 是 worker 源码的擦除产物
  });

  it('正常路径零降级告警（bootDegraded 缺席——护栏不误伤）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, 'return "ok";');
    expect(r.ok).toBe(true);
    expect((r.output as { bootDegraded?: string }).bootDegraded).toBeUndefined();
  });

  it('快照落盘可读（磁盘快照层），再次 run 正常（多候选共存不冲突）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r1 = await call(ctx, 'return 2;');
    expect(r1.ok).toBe(true);
    // 快照已随首次成功 run 落盘（tmpdir）；再跑一次确认 dev 候选优先、行为不变
    const r2 = await call(ctx, 'const a = await tools.echo({ text: "snap" });\nreturn a.output?.echoed;');
    expect(r2.ok).toBe(true);
    expect((r2.output as { value: unknown }).value).toBe('snap');
  });

  it('bundle 形态（无 worker.ts，仅 worker.mjs）→ bundle 候选中选、零降级告警（0.8.11 回归锁）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    // 模拟发布形态：dev 入口缺席、bundle 入口在场。bundle 引导文件 = esbuild
    // 自包含产物（与 build-bundle 第二入口同构——依赖内联，任意目录可引导；
    // dev 快照夹具不可用：strip 产物仍含相对 import './protocol.ts'，落 tmpdir 即断）。
    const { build } = await import('esbuild');
    const bundleJsFile = runCodeRow.__runCodeTestHooks.seedDiskSnapshot(
      'bundle-fixture',
      await build({
        entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
        bundle: true,
        format: 'esm',
        platform: 'node',
        write: false,
        logLevel: 'silent',
      }).then((res) => res.outputFiles[0].text),
    );
    const restore = runCodeRow.__runCodeTestHooks.overrideWorkerEntries(
      () => 'Z:/nonexistent/worker.ts', // dev 缺席（发布形态）
      () => bundleJsFile, // bundle 在场
    );
    try {
      const r = await call(ctx, 'return "from-bundle";');
      expect(r.ok, r.error ?? '').toBe(true);
      expect((r.output as { value: unknown }).value).toBe('from-bundle');
      expect((r.output as { bootDegraded?: string }).bootDegraded).toBeUndefined(); // bundle 中选 ≠ 降级
    } finally {
      restore();
    }
  });
});

describe('ac-run-code：立项③ lib 注册表自愈', () => {
  it('resolve() 无参 → 纯静态清单摘要（kind/size/preview，不执行库源码）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, [
      "lib.define('add', (a, b) => a + b);",
      "lib.define('cfg', 'return { n: 42 };');",
      "const list = lib.resolve() as Record<string, { kind: string; size: number; preview: string }>;",
      "return { addKind: list.add.kind, cfgKind: list.cfg.kind, addPreview: list.add.preview, cfgSize: list.cfg.size };",
    ].join('\n'));
    expect(r.ok, r.error ?? '').toBe(true);
    const v = (r.output as { value: Record<string, unknown> }).value;
    expect(v.addKind).toBe('function');
    expect(v.cfgKind).toBe('program');
    expect(String(v.addPreview)).toContain('a + b');
    expect(Number(v.cfgSize)).toBeGreaterThan(10);
  });

  it('resolve() 无参不执行程序体库（清单摘要 ≠ 求值对象——纯静态）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, [
      "lib.define('cfg', 'return { n: 42 };');",
      "// 程序体形态：resolve('cfg') 求值得对象（执行）；resolve() 清单只给 {kind:'program'} 摘要",
      "const list = lib.resolve() as Record<string, { kind: string; preview: string }>;",
      "const body = lib.resolve('cfg') as { n: number };",
      "return { listIsSummary: typeof (list.cfg as unknown) === 'object' && list.cfg.kind === 'program' && !('n' in list.cfg), bodyRan: body.n };",
    ].join('\n'));
    expect(r.ok, r.error ?? '').toBe(true);
    const v = (r.output as { value: Record<string, unknown> }).value;
    expect(v.listIsSummary).toBe(true); // 清单是摘要而非求值结果（无 n 字段）
    expect(v.bodyRan).toBe(42); // 具名 resolve 仍求值（使用路径不变）
  });

  it('坏库调用期 ReferenceError → 可读错误（指向 define 闭包陷阱）+ rot 剔除', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    // 直接种坏条目进会话级 store（模拟历史遗留），本 run 注入后调用
    runCodeRow.__runCodeTestHooks.seedLibStore('tester', 'conv-test', {
      badLib: '(s) => s.slice(0, MISSING_LIMIT)',
    });
    const r = await call(ctx, [
      "const bad = lib.resolve('badLib') as (s: string) => string;",
      "try { bad('x'); return 'unexpected'; }",
      "catch (e) { return String(e); }",
    ].join('\n'));
    expect(r.ok).toBe(true);
    const v = String((r.output as { value: unknown }).value);
    expect(v).toContain('ReferenceError');
    expect(v).toContain('badLib');
    expect(v).toContain('fn.toString()'); // 可读指引而非裸错
    // rot 剔除：store 里 badLib 已删
    expect(runCodeRow.__runCodeTestHooks.libStoreKeys('tester', 'conv-test')).not.toContain('badLib');
  });

  it('被吞掉的 ReferenceError 也触发剔除（try/catch 不遮蔽 rot 事实）', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    runCodeRow.__runCodeTestHooks.seedLibStore('tester', 'conv-test', {
      silentBad: '(n) => n * OUTER_FACTOR',
    });
    const r = await call(ctx, [
      "const f = lib.resolve('silentBad') as (n: number) => number;",
      "try { f(1); } catch { /* 吞掉 */ }",
      "return 'done';",
    ].join('\n'));
    expect(r.ok).toBe(true);
    expect((r.output as { libRotted?: string[] }).libRotted).toEqual(['silentBad']);
    expect(runCodeRow.__runCodeTestHooks.libStoreKeys('tester', 'conv-test')).not.toContain('silentBad');
  });

  it('好库零干扰（回归）：正常 define/resolve/调用不受包裹层影响', async () => {
    const { ctx } = await boot({ agentTags: ['fs', 'infra'] });
    const r = await call(ctx, [
      "lib.define('good', (x: number) => x * 2);",
      "const g = lib.resolve('good') as (x: number) => number;",
      "return { direct: lib.good(5), resolved: g(6) };",
    ].join('\n'));
    expect(r.ok, r.error ?? '').toBe(true);
    const v = (r.output as { value: Record<string, number> }).value;
    expect(v.direct).toBe(10);
    expect(v.resolved).toBe(12);
    expect((r.output as { libRotted?: string[] }).libRotted).toBeUndefined();
  });
});

