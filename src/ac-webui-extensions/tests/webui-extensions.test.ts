// ============================================================
// ac-webui-extensions：UI 扩展 slot 注册表行冒烟（内置白名单→注册→dispose 回收）
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, type Fiber } from '@agentchat/cordis';
import * as webuiRow from '../src/index.ts';
import { BUILTIN_SLOTS } from '../src/index.ts';

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];

async function boot() {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const fiber = ctx.plugin(webuiRow as any);
  await fiber;
  fibers.push(fiber);
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

describe('ac-webui-extensions', () => {
  it('注册面：行挂载即声明全部内置 slot 白名单', async () => {
    const { ctx } = await boot();
    const slots = ctx.uiExtensions.listSlots();
    expect(slots.map((s) => s.id)).toEqual(BUILTIN_SLOTS.map((s) => s.id));
  });

  it('执行：插件 register 进已声明 slot → list 可见', async () => {
    const { ctx } = await boot();
    await ctx.uiExtensions.register({
      name: 'smoke-ext',
      version: '0.1.0',
      slot: 'sidebar-action',
      order: 10,
      payload: { kind: 'button', label: '冒烟按钮' },
    });
    const entries = ctx.uiExtensions.list('sidebar-action');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'smoke-ext',
      version: '0.1.0',
      slot: 'sidebar-action',
      order: 10,
      isolated: false,
      sessionOnly: false,
    });
    // 未声明 slot → fail-closed 抛错（宿主先开口插件后填空）
    await expect(
      ctx.uiExtensions.register({ name: 'smoke-bad', version: '0.1.0', slot: 'not-a-slot' }),
    ).rejects.toThrow('未声明');
  });

  it('dispose：行 fiber 卸载后服务与白名单一并回收', async () => {
    const { ctx, fibers } = await boot();
    await fibers[0]!.dispose();
    expect(fibers[0]!.uid).toBe(null);
    expect(ctx.get('uiExtensions')).toBeUndefined();
  });
});
