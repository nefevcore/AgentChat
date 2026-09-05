// ============================================================
// ac-hello：链路验证行生命周期冒烟（hello 工具注册→执行→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as toolsRow from 'ac-tools';
import * as helloRow from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  for (const row of [toolsRow, helloRow]) {
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

describe('ac-hello', () => {
  it('注册面：行挂载后 hello 工具进入注册表', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.has('hello')).toBe(true);
    expect(ctx.tools.get('hello')?.name).toBe('hello');
  });

  it('执行：hello 回显消息（ac-tools 执行链端到端）', async () => {
    const { ctx } = await boot();
    const r = await ctx.tools.execute({ name: 'hello', args: { message: '链路' } });
    expect(r).toEqual({ ok: true, output: 'hello: 链路' });
  });

  it('dispose：hello fiber 卸载后工具回收不可再执行', async () => {
    const { ctx, fibers } = await boot();
    await fibers[1]!.dispose();
    expect(fibers[1]!.uid).toBe(null);
    expect(ctx.tools.has('hello')).toBe(false);
    const r = await ctx.tools.execute({ name: 'hello', args: { message: 'x' } });
    expect(r).toEqual({ ok: false, error: 'unknown tool: hello' });
  });
});
