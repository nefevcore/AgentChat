// ============================================================
// ac-math：vm 沙箱求值
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as mathRow from '../src/index.ts';
import { evaluateExpression } from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, mathRow]) {
    const fiber = ctx.plugin(row as any);
    await fiber;
    fibers.push(fiber);
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
});

describe('ac-math', () => {
  it('基础表达式 / Math 函数全局化 / 浮点归一化 / bigint', () => {
    expect(evaluateExpression('1+2*3')).toEqual({ ok: true, value: '7' });
    expect(evaluateExpression('sqrt(16)')).toEqual({ ok: true, value: '4' });
    expect(evaluateExpression('2**10')).toEqual({ ok: true, value: '1024' });
    expect(evaluateExpression('0.1+0.2')).toEqual({ ok: true, value: '0.3' });
    expect(evaluateExpression('sin(PI/2)')).toEqual({ ok: true, value: '1' });
    expect(evaluateExpression('10n**21n')).toEqual({ ok: true, value: '1000000000000000000000' });
  });

  it('沙箱隔离：process/require 不可见（globalThis 上也无）；语句无返回值报错；死循环超时', () => {
    expect(evaluateExpression('process').ok).toBe(false);
    expect(evaluateExpression('require').ok).toBe(false);
    // vm 的 globalThis 指向沙箱全局自身（只有白名单 + 内置），其上无危险属性
    expect(evaluateExpression('globalThis.process').ok).toBe(false);
    expect(evaluateExpression('globalThis.require').ok).toBe(false);
    const stmt = evaluateExpression('let x = 1;');
    expect(stmt.ok).toBe(false);
    expect(stmt).toMatchObject({ message: expect.stringContaining('无返回值') });
    const loop = evaluateExpression('while(true){}');
    expect(loop.ok).toBe(false);
  });

  it('工具注册与执行', async () => {
    const { ctx } = await boot();
    const r = await ctx.tools.execute({ name: 'math', args: { expression: '(1+2**10)/4' } });
    expect(r).toEqual({ ok: true, output: { expression: '(1+2**10)/4', result: '256.25' } });
    const bad = await ctx.tools.execute({ name: 'math', args: { expression: '' } });
    expect(bad.ok).toBe(false);
  });
});
