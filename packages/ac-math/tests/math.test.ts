// ============================================================
// ac-math：纯表达式解析求值（A2 加固后：node:vm 已移除）
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
  it('基础表达式 / 函数全局化 / 浮点归一化 / bigint / Math. 前缀', () => {
    expect(evaluateExpression('1+2*3')).toEqual({ ok: true, value: '7' });
    expect(evaluateExpression('sqrt(16)')).toEqual({ ok: true, value: '4' });
    expect(evaluateExpression('2**10')).toEqual({ ok: true, value: '1024' });
    expect(evaluateExpression('0.1+0.2')).toEqual({ ok: true, value: '0.3' });
    expect(evaluateExpression('sin(PI/2)')).toEqual({ ok: true, value: '1' });
    expect(evaluateExpression('10n**21n')).toEqual({ ok: true, value: '1000000000000000000000' });
    expect(evaluateExpression('Math.pow(2,10)')).toEqual({ ok: true, value: '1024' });
    expect(evaluateExpression('Math.max(1, 2, 3) + Math.E * 0')).toEqual({ ok: true, value: '3' });
    expect(evaluateExpression('7 % 3')).toEqual({ ok: true, value: '1' });
    expect(evaluateExpression('-2**2')).toEqual({ ok: true, value: '-4' });
    expect(evaluateExpression('0x10 + 0b101')).toEqual({ ok: true, value: '21' });
  });

  it('沙箱语义：非白名单标识符/JS 语法一律解析失败（vm 逃逸载荷回归）', () => {
    expect(evaluateExpression('process').ok).toBe(false);
    expect(evaluateExpression('require').ok).toBe(false);
    expect(evaluateExpression('globalThis.process').ok).toBe(false);
    // 实测逃逸 PoC（宿主 Function 构造器链）——现在是解析错误而非 RCE
    expect(
      evaluateExpression('Math.constructor.constructor("return process")().mainModule.require("child_process")').ok,
    ).toBe(false);
    // 异步冻结载荷——Promise 不是白名单标识符
    expect(evaluateExpression('Promise.resolve().then(()=>{while(true){}})').ok).toBe(false);
    // 语句/赋值/字符串/成员链/箭头函数
    expect(evaluateExpression('let x = 1;').ok).toBe(false);
    expect(evaluateExpression('x = 1').ok).toBe(false);
    expect(evaluateExpression('"2"+2').ok).toBe(false);
    expect(evaluateExpression('constructor.constructor').ok).toBe(false);
    expect(evaluateExpression('(()=>1)()').ok).toBe(false);
    // 死循环语句在语法层就不存在（不再是靠 vm timeout 兜底）
    expect(evaluateExpression('while(true){}').ok).toBe(false);
  });

  it('资源护栏：巨数幂 / 超长表达式 / 超深嵌套快速失败', () => {
    expect(evaluateExpression('10n**99999999n').ok).toBe(false);
    expect(evaluateExpression('1+'.repeat(2000) + '1').ok).toBe(false);
    expect(evaluateExpression('('.repeat(500) + '1' + ')'.repeat(500)).ok).toBe(false);
  });

  it('工具注册与执行', async () => {
    const { ctx } = await boot();
    const r = await ctx.tools.execute({ name: 'math', args: { expression: '(1+2**10)/4' } });
    expect(r).toEqual({ ok: true, output: { expression: '(1+2**10)/4', result: '256.25' } });
    const bad = await ctx.tools.execute({ name: 'math', args: { expression: '' } });
    expect(bad.ok).toBe(false);
  });
});
