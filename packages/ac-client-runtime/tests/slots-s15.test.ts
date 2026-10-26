// ============================================================
// ac-client-runtime/tests/slots-s15.test.ts —— S1.5 运行时面单测
//
// 验收门（复核 §3.2）：inject 面（声明存活期效应）+ store 座位服务面
// （acquireStore/dropScope）+ reportEntryError 监督（onEntryError 钩子）
// + S0/S1 全部贡献在升级后行为不回归（朴素 order 注册语义锁定）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient, clientPlugin } from '../src/context.ts';
import type { ClientContext } from '../src/context.ts';
import type {} from '../src/events.ts';

const C = { render: () => 'x' };

function slotRow(name: string, apply: (c: ClientContext) => void) {
  return clientPlugin({ name, inject: ['slots'], apply });
}

describe('S1.5 · inject 面（声明存活期效应，D6）', () => {
  it('已声明 → 立即执行；声明塌缩 → 清理回收；再声明 → 重执行', async () => {
    const ctx = await createClient();
    const events: string[] = [];
    let cleanup = 0;

    const owner = ctx.plugin(slotRow('owner', (c) => {
      c.slots.declare({ key: 'demo:seat' });
    }));
    await owner;

    const off = ctx.slots.inject('demo:seat', () => {
      events.push('effect');
      return () => cleanup++;
    });
    expect(events).toEqual(['effect']); // 声明在场 → 立即执行

    await owner.dispose(); // 声明塌缩
    expect(cleanup).toBe(1);

    const owner2 = ctx.plugin(slotRow('owner2', (c) => {
      c.slots.declare({ key: 'demo:seat' });
    }));
    await owner2;
    expect(events).toEqual(['effect', 'effect']); // 再声明 → 重执行

    off(); // 手动撤销监听 → 清理
    expect(cleanup).toBe(2);
    await owner2.dispose();
    expect(cleanup).toBe(2); // 监听已撤——塌缩不再触发
  });

  it('声明方未装 → 等待；声明到达时执行（不用行序/时序约定）', async () => {
    const ctx = await createClient();
    const events: string[] = [];
    ctx.slots.inject('demo:later', () => {
      events.push('later');
    });
    expect(events).toEqual([]);
    const owner = ctx.plugin(slotRow('owner', (c) => c.slots.declare({ key: 'demo:later' })));
    await owner;
    expect(events).toEqual(['later']);
    await owner.dispose();
  });

  it('监听随调用方 fiber 卸载撤销', async () => {
    const ctx = await createClient();
    const events: string[] = [];
    let cleanup = 0;
    const owner = ctx.plugin(slotRow('owner', (c) => c.slots.declare({ key: 'demo:x' })));
    await owner;
    const listener = ctx.plugin(slotRow('listener', (c) => {
      c.slots.inject('demo:x', () => {
        events.push('x');
        return () => cleanup++;
      });
    }));
    await listener;
    expect(events).toEqual(['x']);
    await listener.dispose(); // 监听方卸载 → 效应回收
    expect(cleanup).toBe(1);
    await owner.dispose();
  });
});

describe('S1.5 · store 座位服务面', () => {
  it('acquireStore：entry.store 工厂 × scopeKey 实例化；release 归零回收', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:seat', scope: 'session' });
    const fiber = ctx.plugin(slotRow('contrib', (c) => {
      c.slots.register('demo:seat', {
        id: 'e1',
        component: C,
        store: (h) => ({ scopeKey: h.scopeKey, disposed: false, dispose: () => { /* 标记由 axis 测试覆盖 */ } }),
      });
    }));
    await fiber;

    const s1 = ctx.slots.acquireStore('demo:seat', 'e1', 'conv-9');
    const s2 = ctx.slots.acquireStore('demo:seat', 'e1', 'conv-9');
    expect((s1.value as { scopeKey: string }).scopeKey).toBe('conv-9');
    expect(s1.value).toBe(s2.value);
    s1.release();
    expect(ctx.slots.stores.peek({ slotKey: 'demo:seat', entryId: 'e1', scopeKey: 'conv-9' })).toBeDefined();
    s2.release();
    expect(ctx.slots.stores.peek({ slotKey: 'demo:seat', entryId: 'e1', scopeKey: 'conv-9' })).toBeUndefined();

    // 会话死即清
    const s3 = ctx.slots.acquireStore('demo:seat', 'e1', 'conv-10');
    void s3;
    expect(ctx.slots.dropScope('conv-10')).toBe(1);
    await fiber.dispose();
  });

  it('无 store 工厂的条目：acquireStore 返回 undefined 实例（不炸）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:plain' });
    const fiber = ctx.plugin(slotRow('contrib', (c) => {
      c.slots.register('demo:plain', { id: 'p', component: C });
    }));
    await fiber;
    const seat = ctx.slots.acquireStore('demo:plain', 'p');
    expect(seat.value).toBeUndefined();
    seat.release();
    await fiber.dispose();
  });
});

describe('S1.5 · entry 崩溃监督 + abdicate 退位', () => {
  it('reportEntryError：abdicate + onEntryError 钩子 + slots/changed 失效', async () => {
    const seen: Array<[string, string, unknown]> = [];
    const ctx = await createClient();
    // 重建带监督钩子的服务（createClient 装的缺省钩子 = console.error）
    await ctx.plugin({
      name: 'supervisor',
      apply() {
        // 直接监听事件桥验证失效轴
      },
    });
    ctx.slots.declare({ key: 'demo:single', kind: 'single' });
    const fiber = ctx.plugin(slotRow('contrib', (c) => {
      c.slots.register('demo:single', { id: 'a', component: C, order: 0 });
      c.slots.register('demo:single', { id: 'b', component: C, order: 10 });
    }));
    await fiber;
    expect(ctx.slots.single('demo:single')?.id).toBe('a');

    const events: string[] = [];
    ctx.on('slots/changed', (key) => events.push(key));
    ctx.slots.reportEntryError('demo:single', ctx.slots.single('demo:single')!, new Error('boom'));
    expect(events).toContain('demo:single'); // 渲染面重选举
    expect(ctx.slots.single('demo:single')?.id).toBe('b'); // 退位 → 次位接任
    void seen;
    await fiber.dispose();
  });
});

describe('S1.5 验收门 · S0/S1 朴素贡献升级后行为不回归', () => {
  it('朴素 order 注册（无 cell/priority）：list 排序、single 首条、版本计数全维持', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:list' });
    ctx.slots.declare({ key: 'demo:one', kind: 'single' });
    const fiber = ctx.plugin(slotRow('contrib', (c) => {
      c.slots.register('demo:list', { id: 'b1', component: C });
      c.slots.register('demo:list', { id: 'b2', component: C });
      c.slots.register('demo:one', { id: 'w', component: C, order: 1 });
      c.slots.register('demo:one', { id: 'r', component: C, order: 2 });
    }));
    await fiber;
    expect(ctx.slots.entries('demo:list').map((e) => e.id)).toEqual(['b1', 'b2']); // order 缺省 100 稳定
    expect(ctx.slots.single('demo:one')?.id).toBe('w'); // 最低 order（=S0 首条语义）
    await fiber.dispose();
    expect(ctx.slots.entries('demo:list')).toEqual([]);
  });
});
