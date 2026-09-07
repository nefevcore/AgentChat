// ============================================================
// ac-client-runtime/tests/slots-registry.test.ts —— SlotRegistry 单测（M27 S0）
//
// 覆盖：服务装载与 ctx.slots 面 / declare+register 经调用方 fiber 的
// 级联回收（插件 dispose → 声明与贡献一并消失）/ 'slots/changed' 事件桥 /
// install boot-once / render 未安装可诊断 / ownerOf 注册方追踪 /
// 出厂封印（root 抢占拒绝）/ inject 纪律（未声明依赖的 fiber 不可见服务）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { Context } from '@agentchat/cordis';
import { SlotCoreError } from 'ac-client-slots';
import { createClient, clientPlugin } from '../src/context.ts';
import type { ClientContext } from '../src/context.ts';
import { SlotsService } from '../src/slots.ts';
import type {} from '../src/events.ts';

const C = { render: () => 'x' };

/** inject ['slots'] 的贡献方插件（D6：依赖一律 inject，不用行序/时序） */
function slotRow(name: string, apply: (c: ClientContext) => void) {
  return clientPlugin({ name, inject: ['slots'], apply });
}

describe('SlotRegistry · 服务面', () => {
  it('createClient 装载内置服务：ctx.slots 可用；declare → register → entries', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:seat', kind: 'list' });
    ctx.slots.register('demo:seat', { id: 'a', component: C, order: 2 });
    ctx.slots.register('demo:seat', { id: 'b', component: C, order: 1 });
    expect(ctx.slots.entries('demo:seat').map((e) => e.id)).toEqual(['b', 'a']);
    expect(ctx.slots.single('demo:seat')?.id).toBe('b');
    expect(ctx.slots.declOf('demo:seat')?.kind).toBe('list');
  });

  it('未声明 key 注册被拒（SlotCoreError 透传）', async () => {
    const ctx = await createClient();
    expect(() => ctx.slots.register('nope:seat', { id: 'a', component: C })).toThrowError(SlotCoreError);
  });

  it('未 inject 的插件 fiber 看不到 ctx.slots（D6 结构性编码）', async () => {
    const ctx = new Context();
    await ctx.plugin(SlotsService);
    const fiber = ctx.plugin(function noInject(c) {
      expect(() => (c as { slots?: unknown }).slots).toThrowError(/without inject/);
    });
    await fiber;
    await fiber.dispose();
  });
});

describe('SlotRegistry · fiber 级联回收（D5）', () => {
  it('注册方插件 dispose → 其贡献自动回收', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:list' });
    const fiber = ctx.plugin(slotRow('demo-contrib', (c) => {
      c.slots.register('demo:list', { id: 'from-plugin', component: C });
    }));
    await fiber;
    expect(ctx.slots.entries('demo:list').map((e) => e.id)).toEqual(['from-plugin']);
    await fiber.dispose();
    expect(ctx.slots.entries('demo:list')).toEqual([]);
  });

  it('声明方插件 dispose → 席位消亡且贡献一并消失', async () => {
    const ctx = await createClient();
    const owner = ctx.plugin(slotRow('demo-owner', (c) => {
      c.slots.declare({ key: 'demo:owned' });
    }));
    await owner;
    const writer = ctx.plugin(slotRow('demo-contrib', (c) => {
      c.slots.register('demo:owned', { id: 'a', component: C });
    }));
    await writer;
    expect(ctx.slots.entries('demo:owned').length).toBe(1);
    await owner.dispose();
    expect(ctx.slots.entries('demo:owned')).toEqual([]);
    // 席位已消亡：贡献方再注册被拒（fail-closed）
    expect(() => ctx.slots.register('demo:owned', { id: 'b', component: C })).toThrowError(SlotCoreError);
    await writer.dispose();
  });

  it('ownerOf 返回注册方 ctx（wrapComponent 隔离 ctx 数据源）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:list' });
    let owner: unknown;
    const fiber = ctx.plugin(slotRow('demo-contrib', (c) => {
      c.slots.register('demo:list', { id: 'a', component: C });
      owner = c;
    }));
    await fiber;
    const entry = ctx.slots.entries('demo:list')[0];
    expect(ctx.slots.ownerOf(entry)).toBe(owner);
    await fiber.dispose();
  });
});

describe('SlotRegistry · 事件桥', () => {
  it("register/撤销/声明撤销均 emit 'slots/changed'（载荷 = key）", async () => {
    const ctx = await createClient();
    const seen: string[] = [];
    ctx.on('slots/changed', (key) => seen.push(key));
    const owner = ctx.plugin(slotRow('demo-owner', (c) => {
      c.slots.declare({ key: 'demo:x' });
    }));
    await owner;
    expect(seen).toEqual(['demo:x']);
    const fiber = ctx.plugin(slotRow('demo-contrib', (c) => {
      c.slots.register('demo:x', { id: 'a', component: C });
    }));
    await fiber;
    expect(seen).toEqual(['demo:x', 'demo:x']);
    await fiber.dispose();
    expect(seen).toEqual(['demo:x', 'demo:x', 'demo:x']);
    await owner.dispose();
    expect(seen).toEqual(['demo:x', 'demo:x', 'demo:x', 'demo:x']);
  });
});

describe('SlotRegistry · 渲染器 boot-once（D4）', () => {
  it('未安装 render 抛可诊断错误；安装后委托；二次安装拒绝', async () => {
    const ctx = await createClient();
    expect(() => ctx.slots.render('root')).toThrowError(/install/);
    const renderer = { framework: 'test', render: (key: string) => [key] };
    ctx.slots.install(renderer);
    expect(ctx.slots.render('root')).toEqual(['root']);
    expect(ctx.slots.installedRenderer?.framework).toBe('test');
    expect(() => ctx.slots.install({ framework: 'other', render: () => [] })).toThrowError(/boot-once/);
  });
});

describe('SlotRegistry · root 单席位纪律（D3）', () => {
  it('出厂装配（封印前）占 root；封印后动态插件抢占被拒', async () => {
    const ctx = await createClient();
    const layout = ctx.plugin(slotRow('demo-layout', (c) => {
      c.slots.declare({ key: 'root', kind: 'single', factory: true });
      c.slots.register('root', { id: 'layout.app-frame', component: C, order: 0 });
    }));
    await layout;
    ctx.slots.sealFactory();
    const evil = ctx.plugin(slotRow('demo-evil', (c) => {
      expect(() => c.slots.register('root', { id: 'evil', component: C })).toThrowError(SlotCoreError);
    }));
    await evil;
    expect(ctx.slots.entries('root').map((e) => e.id)).toEqual(['layout.app-frame']);
    await evil.dispose();
    await layout.dispose();
  });
});
