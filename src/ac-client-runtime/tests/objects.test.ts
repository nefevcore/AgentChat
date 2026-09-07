// ============================================================
// ac-client-runtime/tests/objects.test.ts —— 层 2 对象层骨架单测（M27 S0）
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient, clientPlugin } from '../src/context.ts';

describe('ObjectsService（对象层骨架）', () => {
  it('define/get/keys；重复定义抛错（单源纪律）', async () => {
    const ctx = await createClient();
    const roster = ctx.objects.define('roster', () => ({ agents: [] as string[] }));
    expect(ctx.objects.get<{ agents: string[] }>('roster')).toBe(roster);
    expect(ctx.objects.keys()).toEqual(['roster']);
    expect(() => ctx.objects.define('roster', () => ({}))).toThrowError(/单源/);
    expect(ctx.objects.get('missing')).toBeUndefined();
  });

  it('拥有权 = 调用方 fiber：插件 dispose 即撤销', async () => {
    const ctx = await createClient();
    const fiber = ctx.plugin(clientPlugin({
      name: 'feeder',
      inject: ['objects'],
      apply(c) {
        c.objects.define('sessions', () => ({ index: [] }));
      },
    }));
    await fiber;
    expect(ctx.objects.get('sessions')).toBeDefined();
    await fiber.dispose();
    expect(ctx.objects.get('sessions')).toBeUndefined();
    // 撤销后可重新定义（无残留）
    ctx.objects.define('sessions', () => ({ index: [] }));
    expect(ctx.objects.get('sessions')).toBeDefined();
  });
});
