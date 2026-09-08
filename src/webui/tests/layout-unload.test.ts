// @vitest-environment jsdom
// ============================================================
// webui/tests/layout-unload.test.ts —— S1 验收：「卸载 layout 件 →
// root 空且有可诊断报错」+ D18 门控三件套
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime';
import { bootWebuiRuntime, denyPerspective } from './lib/webuiBoot';
import type { VueSlotRenderer } from '../src/runtime/vueRenderer';
import PerspectiveHost from 'ac-client-ui-layout/client/PerspectiveHost.vue';
import { registerPerspective, activePerspective } from '../src/core/registry/perspectives';

const C0 = { render: () => null };

describe('S1 验收 · 卸载 layout 件 → root 空且可诊断（宿主不残废）', () => {
  it('layout fiber dispose → root 席位/声明级联回收 + DEV 渲染诊断横幅', async () => {
    const { ctx, fibers } = await bootWebuiRuntime();
    expect(ctx.slots.entries('root').map((e) => e.id)).toEqual(['webui-base-layout.app-frame']);

    await fibers.layout.dispose();
    expect(ctx.slots.entries('root')).toEqual([]);
    expect(ctx.slots.declOf('root')).toBeUndefined();
    // 四 seat 随 owner 消亡（插件卸载 = 后端能力 + 前端消费面一并消失的 UI 形态）
    expect(ctx.slots.declOf('sidebar')).toBeUndefined();
    expect(ctx.slots.declOf('main')).toBeUndefined();

    // 渲染诊断面：renderSlot('root') → DEV 诊断横幅（有可诊断报错）
    const renderer = ctx.slots.installedRenderer as VueSlotRenderer;
    const host = document.createElement('div');
    const app = createApp({ render: () => renderer.renderSlot('root') });
    app.mount(host);
    expect(host.textContent ?? '').toContain('root 席位为空');
    expect(host.textContent ?? '').toContain('layout');
    app.unmount();
  });
});

describe('D18 门控三件套（视角注册项）', () => {
  it('bail：无监听放行；宿主一行拒绝 → PerspectiveHost 渲染空（注册变更时重评估）', async () => {
    const { ctx } = await bootWebuiRuntime();
    const off = registerPerspective({
      id: 'gated',
      label: '受制视角',
      active: () => true,
      component: { render: () => h('b', null, 'GATED') },
      bail: { event: 'activity/perspective' },
    });

    const host = document.createElement('div');
    const app = createApp({ render: () => h(PerspectiveHost) });
    app.use(createPinia());
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    app.mount(host);
    await nextTick();
    expect(host.textContent).toContain('GATED'); // 无监听 = 放行

    const deny = await ctx.plugin(denyPerspective);
    // bail 门控为拉取式（同 Koishi activity.disabled）：注册表变更时重评估
    const bump = registerPerspective({ id: 'bump', label: '触发重评估', active: () => false, component: C0 });
    bump();
    await nextTick();
    expect(host.textContent ?? '').not.toContain('GATED'); // 拒绝一切活动项
    app.unmount();
    await deny.dispose();
    off();
  });

  it('fields 数据就绪门控：对象层键未定义 → 视角不激活', async () => {
    await bootWebuiRuntime();
    const off = registerPerspective({
      id: 'needs-roster',
      label: '需名册',
      active: () => true,
      component: { render: () => null },
      fields: ['roster'],
    });
    expect(activePerspective()?.id).not.toBe('needs-roster');
    off();
  });

  it('redirectTo 卸载导航：激活中的视角被撤销 → 回退动作执行', async () => {
    await bootWebuiRuntime();
    let fellBack = false;
    const off = registerPerspective({
      id: 'temp',
      label: '临时',
      active: () => true,
      component: { render: () => null },
      redirectTo: () => { fellBack = true; },
    });
    expect(activePerspective()?.id).toBe('temp');
    off();
    expect(fellBack).toBe(true);
  });
});

// 内部 mount 冒烟：AppFrame（root 占据者）经 SlotOutlet 真渲染出四 seat 骨架
describe('AppFrame 席位渲染冒烟', () => {
  it('mount root 席位 → .app-layout 骨架出现（Outlet 零包裹）', async () => {
    const { ctx } = await bootWebuiRuntime();
    const renderer = ctx.slots.installedRenderer as VueSlotRenderer;
    const host = document.createElement('div');
    const app = createApp({ render: () => renderer.renderSlot('root') });
    app.use(createPinia());
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    app.mount(host);
    await nextTick();
    const layout = host.querySelector('.app-layout');
    expect(layout).not.toBeNull();
    expect(host.querySelector('.sidebar')).not.toBeNull();
    expect(host.querySelector('.main-area')).not.toBeNull();
    app.unmount();
  });
});
