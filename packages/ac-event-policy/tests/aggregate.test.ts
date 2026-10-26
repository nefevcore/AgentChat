// ============================================================
// ac-event-policy/tests/aggregate.test.ts —— M25 §3.5 fiber→行聚合
//   · 程序化组合（bootTree 形态）：root 直接子 fiber = 顶层行——
//     服务 fiber（类名 runtime）聚合到行名；模块行 fiber 名 = 行名（不进映射）
//   · 聚合只改呈现不改键：events/listeners 的 row 字段、治理双命中共用
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { Context, Service, type Fiber, type Plugin } from '@agentchat/cordis';
import { computeRowAggregates, rowOfFiber } from '../src/aggregate.ts';

const ctxs: Context[] = [];

afterEach(async () => {
  for (const ctx of ctxs.splice(0)) {
    await ctx.fiber.dispose();
  }
});

/** 行内服务（构造器注册监听——fiber = 服务子 fiber，runtime 名 = 类名） */
class WidgetService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'widget');
  }
}

const widgetRow: Plugin = {
  name: 'ac-widget',
  apply(c: Context) {
    c.plugin(WidgetService);
  },
} as Plugin;

const leafRow: Plugin = {
  name: 'ac-leaf',
  inject: ['widget'],
  apply() {},
} as Plugin;

describe('fiber→顶层行聚合（M25 §3.5）', () => {
  it('程序化组合：服务类名 → 行名；模块行自身不进映射（名即行名）', async () => {
    const ctx = new Context();
    ctxs.push(ctx);
    await ctx.plugin(widgetRow);
    await ctx.plugin(leafRow);

    const aggregate = computeRowAggregates(ctx);
    // WidgetService 服务 fiber 聚合到 ac-widget 行
    expect(aggregate.get('WidgetService')).toBe('ac-widget');
    // ac-widget / ac-leaf 模块行 fiber 名 = 行名（无需映射）
    expect(aggregate.has('ac-widget')).toBe(false);
    expect(aggregate.has('ac-leaf')).toBe(false);

    // rowOfFiber：服务 fiber → 行名；顶层行 fiber → 自身
    const serviceFiber = [...([...ctx.registry.values()].find((r) => r.name === 'WidgetService')?.fibers ?? [])][0] as Fiber | undefined;
    expect(serviceFiber && rowOfFiber(ctx, serviceFiber)).toBe('ac-widget');
    const rowFiber = [...([...ctx.registry.values()].find((r) => r.name === 'ac-leaf')?.fibers ?? [])][0] as Fiber;
    expect(rowOfFiber(ctx, rowFiber)).toBe('ac-leaf');
  });

  it('无 loader 的组合：聚合对 root 自指链安全（不挂死）', async () => {
    const ctx = new Context();
    ctxs.push(ctx);
    await ctx.plugin(leafRow);
    // root fiber 自指——rowOfFiber 应终止（root 自身名 'root' 而非行名）
    expect(rowOfFiber(ctx, ctx.fiber as unknown as Fiber)).toBe('root');
    expect(computeRowAggregates(ctx).size).toBe(0);
  });
});
