// @vitest-environment jsdom
// ============================================================
// webui/tests/slot-s15.test.ts —— S1.5 渲染面集成（Outlet 选举 + 崩溃边界）
//
// 验收门（复核 §3.2）：cell/priority 选举经 SlotOutlet 渲染生效；
// entry 崩溃 → EntryErrorBoundary 上报 → abdicate 退位 → 次位接任
// （onEntryError 监督 + D16 fallback 衔接：无贡献回落默认插槽）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { CLIENT_CONTEXT_KEY, createClient } from 'ac-client-runtime';
import SlotOutlet from 'ac-client-ui-renderer/client/SlotOutlet.vue';

const Label = defineComponent({
  props: { label: { type: String, default: '?' }, data: { type: null, default: undefined } },
  template: '<b class="lbl">{{ label }}</b>',
});

const Boom = defineComponent({
  setup() {
    throw new Error('entry crash');
  },
  template: '<i>never</i>',
});

function mountOutlet(ctx: Awaited<ReturnType<typeof createClient>>, name: string, defaultSlot?: () => ReturnType<typeof h>[]) {
  const host = document.createElement('div');
  const app = createApp({ render: () => h(SlotOutlet, { name }, defaultSlot ? { default: defaultSlot } : {}) });
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  app.mount(host);
  return { host, unmount: () => app.unmount() };
}

describe('S1.5 · single cell 选举经 Outlet 渲染', () => {
  it('高 priority shadow 低者（D16-② 衔接：无贡献回落默认插槽）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:one', kind: 'single' });
    const { host } = mountOutlet(ctx, 'demo:one', () => [h('div', { class: 'fallback' }, '默认')]);
    expect(host.querySelector('.fallback')).not.toBeNull(); // 无贡献 → 默认插槽

    const fiber = ctx.plugin({
      name: 'contrib',
      inject: ['slots'],
      apply(c) {
        c.slots.register('demo:one', { id: 'base', component: Label, order: 0, props: { label: 'BASE' } });
        c.slots.register('demo:one', { id: 'shadow', component: Label, order: 999, priority: 10, props: { label: 'SHADOW' } });
      },
    });
    await fiber;
    await nextTick();
    expect(host.textContent).toContain('SHADOW'); // 选举赢家渲染（非 order 首条）
    expect(host.textContent).not.toContain('BASE');
    expect(host.querySelector('.fallback')).toBeNull();
    await fiber.dispose();
    await nextTick();
    expect(host.querySelector('.fallback')).not.toBeNull(); // 撤销 → 回落
  });
});

describe('S1.5 · entry 崩溃 → abdicate 退位 → 次位接任', () => {
  it('渲染期抛错的 entry 退位，选举落到下一候选（Outlet 存活不白屏）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:one', kind: 'single' });
    const { host } = mountOutlet(ctx, 'demo:one');

    const fiber = ctx.plugin({
      name: 'contrib',
      inject: ['slots'],
      apply(c) {
        c.slots.register('demo:one', { id: 'crasher', component: Boom, order: 0, priority: 100 });
        c.slots.register('demo:one', { id: 'survivor', component: Label, order: 10, props: { label: 'SURVIVOR' } });
      },
    });
    await fiber;
    await nextTick();
    await nextTick();
    // 崩溃条目已退位（console.error 已由缺省监督面记录）；幸存者接任
    expect(ctx.slots.single('demo:one')?.id).toBe('survivor');
    expect(host.textContent).toContain('SURVIVOR');
    // 退位条目从 entries 消失
    expect(ctx.slots.entries('demo:one').map((e) => e.id)).toEqual(['survivor']);
    await fiber.dispose();
  });

  it('list 型崩溃条目同样退位消失（其余条目继续渲染）', async () => {
    const ctx = await createClient();
    ctx.slots.declare({ key: 'demo:list' });
    const { host } = mountOutlet(ctx, 'demo:list');
    const fiber = ctx.plugin({
      name: 'contrib',
      inject: ['slots'],
      apply(c) {
        c.slots.register('demo:list', { id: 'ok', component: Label, order: 1, props: { label: 'OK1' } });
        c.slots.register('demo:list', { id: 'crasher', component: Boom, order: 2 });
        c.slots.register('demo:list', { id: 'ok2', component: Label, order: 3, props: { label: 'OK2' } });
      },
    });
    await fiber;
    await nextTick();
    await nextTick();
    expect(ctx.slots.entries('demo:list').map((e) => e.id)).toEqual(['ok', 'ok2']);
    expect(host.textContent).toContain('OK1');
    expect(host.textContent).toContain('OK2');
    await fiber.dispose();
  });
});
