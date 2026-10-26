// ============================================================
// ac-tools/tests/readers.test.ts —— agentOf 读取器单测（M25 §3.2）
// + tool/started·registered·unregistered emit 契约锁定
//（cr-347：三读取器与三个 emit 事件此前零测试——读取器对齐
// ac-agent-loop tests/readers.test.ts 先例；emit 契约随假契约
// 修复〔ToolTransform.error 填充〕一并锁定）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from '../src/index.ts';
import { agentOfExecution, agentOfToolCall, agentOfToolTransform } from '../src/readers.ts';

const booted: { ctx: Context; fibers: Fiber[] }[] = [];

async function boot() {
  const ctx = new Context();
  const root = ctx.plugin(toolsRow);
  await root;
  booted.push({ ctx, fibers: [root] });
  return ctx;
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of fibers) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
});

describe('ac-tools agentOf 读取器（M25 §3.2）', () => {
  it('agentOfExecution：before-execute 载体 → call.agentId', () => {
    expect(agentOfExecution({ call: { name: 'read', agentId: 'a1' } })).toBe('a1');
    expect(agentOfExecution({ call: { name: 'read' } })).toBeUndefined();
  });

  it('agentOfToolTransform：transform-result 载体 → call.agentId', () => {
    const payload = { call: { name: 'edit', agentId: 'a2' }, result: { ok: true }, durationMs: 5 };
    expect(agentOfToolTransform(payload)).toBe('a2');
    expect(agentOfToolTransform({ call: { name: 'edit' }, result: { ok: false, error: 'x' }, durationMs: 0 })).toBeUndefined();
  });

  it('agentOfToolCall：after-execute/progress 首参 → agentId（缺失与 undefined 同形）', () => {
    expect(agentOfToolCall({ name: 'bash', agentId: 'a3' })).toBe('a3');
    expect(agentOfToolCall({ name: 'bash' })).toBeUndefined();
    expect(agentOfToolCall({ name: 'x', agentId: undefined })).toBeUndefined();
  });
});

describe('ac-tools emit 契约（cr-347 锁定）', () => {
  it('tool/started：放行后 emit、veto 路径不 emit（无「开始」事实）', async () => {
    const ctx = await boot();
    ctx.tools.register({ name: 'p', execute: () => ({ ok: true }) });
    let started = 0;
    ctx.on('tool/started', () => started++);
    ctx.on('tool/before-execute', (_e, next) => ({ ok: false, error: 'vetoed' }));
    await ctx.tools.execute({ name: 'p' });
    expect(started).toBe(0);
  });

  it('tool/registered 注册生效即 emit；tool/unregistered 随 fiber 卸载 emit（载荷仅 name）', async () => {
    const ctx = await boot();
    const trace: string[] = [];
    ctx.on('tool/registered', (def) => trace.push(def.name));
    ctx.on('tool/unregistered', (name) => trace.push('!' + name));
    ctx.tools.register({ name: 'temp', execute: () => ({ ok: true }) });
    expect(trace).toEqual(['temp']);
    const fiber = ctx.plugin({
      name: 'mock-row',
      inject: ['tools'],
      apply(c: Context) {
        c.tools.register({ name: 'from-row', execute: () => ({ ok: true }) });
      },
    } as any);
    await fiber;
    booted[booted.length - 1].fibers.push(fiber);
    expect(trace).toEqual(['temp', 'from-row']);
    await fiber.dispose();
    expect(trace).toEqual(['temp', 'from-row', '!from-row']);
  });

  it('ToolTransform.error 随 payload 构造填充——工具体抛错时变换链可见原始 Error', async () => {
    const ctx = await boot();
    ctx.tools.register({
      name: 'boom',
      execute: () => {
        throw new Error('原始错误');
      },
    });
    const seen: unknown[] = [];
    ctx.on('tool/transform-result', (payload, next) => {
      seen.push(payload.error);
      return next();
    });
    await ctx.tools.execute({ name: 'boom' });
    expect(seen[0]).toBeInstanceOf(Error);
    expect((seen[0] as Error).message).toBe('原始错误');
  });

  it('成功路径 payload 不携带 error 字段（可选字段缺省语义）', async () => {
    const ctx = await boot();
    ctx.tools.register({ name: 'ok', execute: () => ({ ok: true, output: '成功' }) });
    let hasErrorField = true;
    ctx.on('tool/transform-result', (payload, next) => {
      hasErrorField = 'error' in payload;
      return next();
    });
    await ctx.tools.execute({ name: 'ok' });
    expect(hasErrorField).toBe(false);
  });
});
