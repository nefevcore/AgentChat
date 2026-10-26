import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from '../src/index';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot(extra: unknown[] = []) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const root = ctx.plugin(toolsRow);
  await root;
  fibers.push(root);
  for (const row of extra) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-tools 注册与执行', () => {
  it('注册/查询/执行 + after-execute 事件', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'echo',
      description: '回显',
      execute: (args) => ({ ok: true, output: String(args.text ?? '') }),
    });
    expect(ctx.tools.list().map((d) => d.name)).toEqual(['echo']);
    const events: Array<[string, boolean]> = [];
    ctx.on('tool/after-execute', (call, result) => events.push([call.name, result.ok]));
    const result = await ctx.tools.execute({ name: 'echo', args: { text: '嗨' } });
    expect(result).toEqual({ ok: true, output: '嗨' });
    expect(events).toEqual([['echo', true]]);
  });

  it('未知工具 → ok:false', async () => {
    const { ctx } = await boot();
    const result = await ctx.tools.execute({ name: 'ghost' });
    expect(result).toEqual({ ok: false, error: 'unknown tool: ghost' });
  });

  it('工具体抛错 → 收敛 ok:false + after-execute 携带 error', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'boom',
      execute: () => {
        throw new Error('炸了');
      },
    });
    const seen: Array<[boolean, unknown]> = [];
    ctx.on('tool/after-execute', (_call, result, error) => seen.push([result.ok, error]));
    const result = await ctx.tools.execute({ name: 'boom' });
    expect(result).toEqual({ ok: false, error: '炸了' });
    expect(seen[0][0]).toBe(false);
    expect(seen[0][1]).toBeInstanceOf(Error);
  });
});

describe('ac-tools waterfall 拦截', () => {
  it('veto：拦截器不调 next 直接拒绝，工具体不执行', async () => {
    const { ctx } = await boot();
    let executed = 0;
    ctx.tools.register({
      name: 'danger',
      execute: () => {
        executed += 1;
        return { ok: true };
      },
    });
    ctx.on('tool/before-execute', (execution, next) =>
      execution.call.name === 'danger' ? { ok: false, error: 'blocked by policy' } : next(),
    );
    const result = await ctx.tools.execute({ name: 'danger' });
    expect(result).toEqual({ ok: false, error: 'blocked by policy' });
    expect(executed).toBe(0);
  });

  it('改写：拦截器注入参数后透传', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'log',
      execute: (args) => ({ ok: true, output: args.text }),
    });
    ctx.on('tool/before-execute', (execution, next) => {
      execution.call = {
        ...execution.call,
        args: { ...(execution.call.args ?? {}), text: `[已审计] ${String(execution.call.args?.text ?? '')}` },
      };
      return next();
    });
    const result = await ctx.tools.execute({ name: 'log', args: { text: 'hello' } });
    expect(result.output).toBe('[已审计] hello');
  });
});

describe('ac-tools 结果变换（tool/transform-result）', () => {
  it('变换：脱敏工具体输出，模型与 after-execute 均见变换后结果', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'secret',
      execute: () => ({ ok: true, output: 'token=abc123 其余内容' }),
    });
    ctx.on('tool/transform-result', (payload, next) => {
      if (typeof payload.result.output === 'string') {
        payload.result = {
          ...payload.result,
          output: payload.result.output.replace(/token=\S+/, 'token=***'),
        };
      }
      return next();
    });
    const notified: unknown[] = [];
    ctx.on('tool/after-execute', (_c, result) => notified.push(result.output));
    const result = await ctx.tools.execute({ name: 'secret' });
    expect(result.output).toBe('token=*** 其余内容');
    expect(notified).toEqual(['token=*** 其余内容']);
  });

  it('多变换器按注册序叠加（掩码 + 截断）', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'long',
      execute: () => ({ ok: true, output: 'a'.repeat(50) }),
    });
    ctx.on('tool/transform-result', (payload, next) => {
      payload.result = { ...payload.result, output: String(payload.result.output).replace(/a/g, 'b') };
      return next();
    });
    ctx.on('tool/transform-result', (payload, next) => {
      payload.result = { ...payload.result, output: String(payload.result.output).slice(0, 10) };
      return next();
    });
    const result = await ctx.tools.execute({ name: 'long' });
    expect(result.output).toBe('b'.repeat(10));
  });

  it('短路替换：不调 next 直接给最终结果', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'x',
      execute: () => ({ ok: true, output: '工具体产出' }),
    });
    ctx.on('tool/transform-result', () => ({ ok: true, output: '替换结果' }));
    const result = await ctx.tools.execute({ name: 'x' });
    expect(result.output).toBe('替换结果');
  });

  it('纯观察变换器（只 next）不改变结果；错误路径仍走变换链', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'boom',
      execute: () => {
        throw new Error('炸了');
      },
    });
    const seen: Array<string | undefined> = [];
    ctx.on('tool/transform-result', (payload, next) => {
      seen.push(payload.result.error);
      return next();
    });
    const result = await ctx.tools.execute({ name: 'boom' });
    expect(result).toEqual({ ok: false, error: '炸了' });
    expect(seen).toEqual(['炸了']);
  });
});

describe('ac-tools fiber 生命周期', () => {
  it('插件卸载 → 注册自动回收，effect 标签可诊断', async () => {
    const { ctx } = await boot();
    const row = {
      name: 'mock-tool-row',
      inject: ['tools'],
      apply(c: Context) {
        c.tools.register({ name: 'temp', execute: () => ({ ok: true }) });
      },
    };
    const fiber = ctx.plugin(row as any);
    await fiber;
    expect(ctx.tools.has('temp')).toBe(true);
    expect(fiber.getEffects().map((e) => e.label)).toContain('tools.register(temp)');
    await fiber.dispose();
    expect(ctx.tools.has('temp')).toBe(false);
  });

  it('listWithOwner：owner = 注册方行名（注册即归属），list() 不泄漏 owner', async () => {
    const { ctx } = await boot();
    const rowA = {
      name: 'row-a',
      inject: ['tools'],
      apply(c: Context) {
        c.tools.register({ name: 'a1', execute: () => ({ ok: true }) });
        c.tools.register({ name: 'a2', execute: () => ({ ok: true }) });
      },
    };
    const fiberA = ctx.plugin(rowA as any);
    await fiberA;
    ctx.tools.register({ name: 'root-tool', execute: () => ({ ok: true }) });

    const detailed = ctx.tools.listWithOwner();
    expect(detailed.find((t) => t.name === 'a1')?.owner).toBe('row-a');
    expect(detailed.find((t) => t.name === 'a2')?.owner).toBe('row-a');
    expect(detailed.find((t) => t.name === 'root-tool')?.owner).toBe('root');
    // list() 契约不变：仍是纯 ToolDefinition 形状
    expect(ctx.tools.list().find((t) => t.name === 'a1')).not.toHaveProperty('owner');

    await fiberA.dispose();
    expect(ctx.tools.listWithOwner().map((t) => t.name)).toEqual(['root-tool']);
  });
});

describe('ac-tools 流式进度（tool/progress，M7）', () => {
  it('工具体调 call.onProgress → 逐片 emit（携带执行身份）+ 调用方回调照常', async () => {
    const { ctx } = await boot();
    ctx.tools.register({
      name: 'stream',
      async execute(_args, call) {
        call.onProgress?.('第一段\n');
        call.onProgress?.('第二段\n');
        return { ok: true, output: '完' };
      },
    });
    const events: Array<{ agentId: string | undefined; chunk: string }> = [];
    ctx.on('tool/progress', (call, chunk) => events.push({ agentId: call.agentId, chunk }));
    const own: string[] = [];
    const result = await ctx.tools.execute({
      name: 'stream',
      agentId: 'a1',
      conversationId: 'c1',
      onProgress: (c) => own.push(c),
    });
    expect(result).toEqual({ ok: true, output: '完' });
    expect(events).toEqual([
      { agentId: 'a1', chunk: '第一段\n' },
      { agentId: 'a1', chunk: '第二段\n' },
    ]);
    expect(own).toEqual(['第一段\n', '第二段\n']);
  });

  it('无 onProgress 的普通工具执行不 emit', async () => {
    const { ctx } = await boot();
    ctx.tools.register({ name: 'plain', execute: () => ({ ok: true }) });
    let count = 0;
    ctx.on('tool/progress', () => count++);
    await ctx.tools.execute({ name: 'plain' });
    expect(count).toBe(0);
  });
});
