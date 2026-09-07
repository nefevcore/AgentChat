// @vitest-environment jsdom
// ============================================================
// webui/tests/slot-render-perf.test.ts —— D14 渲染性能基准（M27 S1 建立）
//
// 量化 slot 渲染面的固定开销（Outlet 解析 / 版本计数失效 / 内外合并 /
// 贡献 vnode 构建），供 S1→S4 各阶段回归对照（锁数量级，不锁绝对值——
// 机器差异容忍；阈值 = 基线量级 × 5 的护栏，防结构性退化）。
// 形态参照 history-render-perf.test.ts（诊断用基准 + 护栏断言）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, defineComponent, nextTick, type Component } from 'vue';
import { CLIENT_CONTEXT_KEY, clientPlugin, createClient, type ClientContext } from 'ac-client-runtime';
import SlotOutlet from '../src/components/SlotOutlet.vue';
import { SlotOutletItem } from '../src/components/SlotOutletItem';

const Leaf = defineComponent({
  props: { label: { type: String, default: '' } },
  template: '<span class="leaf">{{ label }}</span>',
});

async function bootBench(): Promise<ClientContext> {
  const ctx = await createClient();
  ctx.slots.declare({ key: 'bench:list', kind: 'list' });
  ctx.slots.declare({ key: 'bench:single', kind: 'single' });
  return ctx;
}

/** N 个条目 × K 轮注册/撤销的 DOM 更新耗时（ms） */
async function benchOutletUpdates(ctx: ClientContext, entries: number, cycles: number): Promise<number> {
  const host = document.createElement('div');
  const app = createApp({
    render: () => h('div', null, [h(SlotOutlet, { name: 'bench:list' })]),
  });
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  app.mount(host);
  const fiber = await ctx.plugin(clientPlugin({
    name: 'bench-contrib',
    inject: ['slots'],
    apply(c) {
      for (let i = 0; i < entries; i++) {
        c.slots.register('bench:list', { id: `e${i}`, component: Leaf, order: i, props: { label: `L${i}` } });
      }
    },
  }));
  await nextTick();

  const t0 = performance.now();
  for (let k = 0; k < cycles; k++) {
    const off = ctx.slots.register('bench:list', { id: `hot${k}`, component: Leaf, order: -1, props: { label: `H${k}` } });
    await nextTick();
    off();
    await nextTick();
  }
  const ms = performance.now() - t0;
  app.unmount();
  await fiber.dispose();
  return ms;
}

describe('D14 · slot 渲染开销基准（S1 基线，逐阶段对照）', () => {
  it('Outlet 渲染：40 条目全量渲染 + 200 轮单条目热更新在护栏内', async () => {
    const ctx = await bootBench();
    const ms = await benchOutletUpdates(ctx, 40, 200);
    // 护栏（非精确断言）：200 轮 (注册→patch→撤销→patch) ≤ 3s——jsdom
    // 下每轮 ~15ms 量级；超阈值 = 版本计数失效范围退化为全局/泄漏
    expect(ms).toBeLessThan(3000);
    console.log(`[D14 基准] 40 条目 × 200 轮热更新 = ${ms.toFixed(1)}ms（≈${(ms / 200).toFixed(2)}ms/轮）`);
  });

  it('细粒度失效：bench:single 的变更不触碰 bench:list 的渲染', async () => {
    const ctx = await bootBench();
    let listRenders = 0;
    const CountingOutlet = defineComponent({
      setup() {
        return () => {
          listRenders++;
          return h(SlotOutlet, { name: 'bench:list' });
        };
      },
    });
    const host = document.createElement('div');
    const app = createApp({ render: () => h(CountingOutlet) });
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    app.mount(host);
    await nextTick();
    const base = listRenders;

    // 无关席位（bench:single）注册/撤销：bench:list Outlet 不应重渲染
    const off = ctx.slots.register('bench:single', { id: 's', component: Leaf });
    await nextTick();
    off();
    await nextTick();
    expect(listRenders).toBe(base); // key 级失效轴（D14/D4）
    app.unmount();
  });

  it('内外合并开销：宿主 20 内置项 × 外部 20 条目单次渲染量级', async () => {
    const ctx = await bootBench();
    const fiber = await ctx.plugin(clientPlugin({
      name: 'bench-contrib',
      inject: ['slots'],
      apply(c) {
        for (let i = 0; i < 20; i++) {
          c.slots.register('bench:list', { id: `x${i}`, component: Leaf, order: i * 2, props: { label: `X${i}` } });
        }
      },
    }));
    const host = document.createElement('div');
    const internal: Component[] = [];
    for (let i = 0; i < 20; i++) {
      internal.push(h(SlotOutletItem, { order: i * 2 + 1 }, () => h('i', null, `H${i}`)));
    }
    const app = createApp({
      render: () => h(SlotOutlet, { name: 'bench:list' }, { default: () => internal }),
    });
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    const t0 = performance.now();
    app.mount(host);
    const ms = performance.now() - t0;
    const leaves = host.querySelectorAll('.leaf').length;
    expect(leaves).toBe(20);
    expect(host.querySelectorAll('i').length).toBe(20);
    // 同轴合并顺序抽查：X0 < H0 < X1 < H1 …（Outlet 为根 → 项直挂 host）
    const texts = [...host.children].map((n) => n.textContent ?? '');
    expect(texts.slice(0, 4)).toEqual(['X0', 'H0', 'X1', 'H1']);
    expect(ms).toBeLessThan(500);
    console.log(`[D14 基准] 40 项同轴合并单次 mount = ${ms.toFixed(1)}ms`);
    app.unmount();
    await fiber.dispose();
  });
});
