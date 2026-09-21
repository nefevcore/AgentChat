// @vitest-environment jsdom
// ============================================================
// webui/tests/main-view-election.test.ts —— 主区视图选举回归
//（2026-11 主区语义纯化：main 席位 keyed 选举多选一——MainViewHost）
//
// 锁三条语义：
//   ① 选举：active × order 多选一——真实 runview 行的 tracking 条目
//      （order 50）激活期间覆盖 chat 兜底（order 100 恒真）；
//   ② 显式导航互斥（2026-12 返回按钮退役后）：openPairView 进会话即收
//      矩阵（开关单一事实源，tracking 谓词只看开关）；openTrackingView
//      进矩阵即清 pair——两方向互斥，无跨页返回联动；行卸载 → 条目
//      消失 → chat 直显（席位占用门控内在于选举——壳不残废）；
//   ③ keepAlive 生命周期策略：chat（keepAlive）曾当选即常驻 v-show
//      （DOM 驻留——输家 display:none 不卸载）；volatile 条目仅当选
//      期间挂载（离列即卸载）；缺陷 def（active 抛错）只失去选举资格。
// ============================================================
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime';
import type { Fiber } from '@agentchat/cordis';

const fibers: Fiber[] = [];

afterEach(async () => {
  for (const f of fibers.splice(0)) await f.dispose();
});

/** 挂 MainViewHost 到独立 app（断言 DOM 生命周期策略） */
async function mountHost(ctx: unknown): Promise<{ host: HTMLElement; unmount: () => void }> {
  const { default: MainViewHost } = await import('ac-client-ui-layout/client/MainViewHost.vue');
  const host = document.createElement('div');
  const app = createApp(MainViewHost);
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  app.mount(host);
  await nextTick();
  return { host, unmount: () => app.unmount() };
}

describe('主区视图选举 · 真实域行条目', () => {
  it('ui-runview tracking 条目：开关驱动选举；pair 让位；行卸载 → chat 直显', async () => {
    const { ctx } = await bootWebuiRuntime();
    const runviewFiber = await ctx.plugin((await import('ac-client-ui-runview/client')).runviewClientPlugin);
    const { activeMainView } = await import('ac-client-ui-layout/client/mainViews.ts');
    setActivePinia(createPinia());
    const ui = (await import('ac-client-ui-layout/client/uiStore.ts')).useUiStore();

    // 初始：开关关 → chat 兜底当选
    expect(activeMainView()?.id).toBe('chat');

    // 开关开 → tracking(50) 覆盖 chat(100)
    ui.trackingViewVisible = true;
    expect(activeMainView()?.id).toBe('tracking');

    // 显式导航互斥（2026-12 返回按钮退役）：openPairView 进会话即收矩阵
    // ——开关单一事实源，tracking 谓词只看开关（悬挂 pair 不再影响矩阵态）
    ui.openPairView('x', 'y');
    expect(ui.pairView).toEqual({ a: 'x', b: 'y' });
    expect(ui.trackingViewVisible).toBe(false);
    expect(activeMainView()?.id).toBe('chat');

    // 反向：openTrackingView 进矩阵即清 pair——两方向互斥
    ui.openTrackingView();
    expect(ui.pairView).toBeNull();
    expect(activeMainView()?.id).toBe('tracking');

    // 行卸载 → 条目消失 → chat 直显（席位占用门控内在于选举）
    await runviewFiber.dispose();
    expect(activeMainView()?.id).toBe('chat');
  });
});

describe('主区视图选举 · 生命周期策略（MainViewHost 渲染面）', () => {
  it('keepAlive 条目常驻 v-show；volatile 条目随选举挂卸；缺陷 def 不击穿', async () => {
    const { ctx } = await bootWebuiRuntime();
    const flag = ref(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Chat = defineComponent({ render: () => h('div', { class: 'mk-chat' }, 'CHAT') });
    const Vol = defineComponent({ render: () => h('div', { class: 'mk-vol' }, 'VOL') });
    // t-chat 居真实 chat 兜底(100) 之前——保证真实 PerspectiveHost 条目
    // 永不赢得选举（不渲染重内核），生命周期断言只作用于受控组件
    const offSticky = ctx.slots.register('main', {
      id: 't-chat', component: Chat, order: 90,
      meta: { def: { id: 't-chat', order: 90, keepAlive: true, active: () => true, component: Chat } },
    });
    const offVol = ctx.slots.register('main', {
      id: 't-vol', component: Vol, order: 50,
      meta: { def: { id: 't-vol', order: 50, active: () => flag.value, component: Vol } },
    });
    const offPoison = ctx.slots.register('main', {
      id: 't-poison', component: Vol, order: 5,
      meta: { def: { id: 't-poison', active: () => { throw new Error('boom'); }, component: Vol } },
    });

    try {
      const { host, unmount } = await mountHost(ctx);
      // 初态：chat 当选（毒 def 跳过 + volatile 未激活）
      expect(host.querySelector('.mk-chat')).toBeTruthy();
      expect(host.querySelector('.mk-vol')).toBeFalsy();
      expect(warn).toHaveBeenCalledOnce();

      // volatile 激活 → 覆盖 chat：chat 仍在 DOM（v-show 隐藏），volatile 挂载
      flag.value = true;
      await nextTick();
      const chatEl = host.querySelector('.mk-chat')!.closest('.main-view-pane') as HTMLElement;
      expect(chatEl.style.display).toBe('none'); // 文档流保活：驻留但隐藏
      expect(host.querySelector('.mk-vol')).toBeTruthy();

      // volatile 失活 → 卸载；chat 回归可见（DOM 未重建——保活）
      flag.value = false;
      await nextTick();
      expect(host.querySelector('.mk-vol')).toBeFalsy();
      const chatEl2 = host.querySelector('.mk-chat')!.closest('.main-view-pane') as HTMLElement;
      expect(chatEl2.style.display).toBe('');
      expect(chatEl2).toBe(chatEl); // 同一 DOM 节点（零重挂载）
      unmount();
    } finally {
      offPoison();
      offVol();
      offSticky();
      warn.mockRestore();
    }
  });
});
