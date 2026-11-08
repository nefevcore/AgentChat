// @vitest-environment jsdom
// ============================================================
// ac-client-ui-layout/tests/crash-hardening.test.ts —— 崩溃隔离三防线
// 回归锁（crash-hardening 批：2026-11-07 root 退位白屏事故收口）
//
// 三防线（DSH 对位物）：
//   ① MainViewHost 选举渲染经 entryVNode——当选视图崩溃 = 退位该条目
//      + 重选举次位（chat 兜底），不上抛击穿壳；
//   ② 出口三态契约——席位曾有贡献且全退位（dead cell）= 崩溃面占位，
//      不再空白（root 退位白屏的收口）；
//   ③ PerspectiveHost 视角级就地降级卡——含 async component loader
//      错误类（事故根因：该 info 标签曾漏过过滤器直穿 root）。
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, defineAsyncComponent } from 'vue';
import { createClient, setClientRuntime, CLIENT_CONTEXT_KEY, type ClientContext } from 'ac-client-runtime';

async function makeCtx(): Promise<ClientContext> {
  const ctx = await createClient();
  setClientRuntime(ctx);
  ctx.slots.declare({ key: 'main', kind: 'list', elect: true });
  ctx.slots.declare({ key: 'main:perspective', kind: 'list', elect: true });
  ctx.slots.declare({ key: 'root', kind: 'single' });
  return ctx;
}

const Marker = (text: string) => defineComponent({
  name: 'Marker' + text,
  render: () => h('div', { class: 'marker' }, text),
});

const Boom = defineComponent({
  name: 'Boom',
  setup() { throw new TypeError('Failed to resolve module specifier（模拟事故词形）'); },
  render: () => null,
});

function mountWith(ctx: ClientContext, node: () => unknown) {
  const app = createApp({ render: () => node() });
  app.provide(CLIENT_CONTEXT_KEY, ctx);
  const el = document.createElement('div');
  document.body.appendChild(el);
  app.mount(el);
  return () => app.unmount();
}

describe('crash-hardening · 防线① MainViewHost 选举渲染崩溃隔离', () => {
  it('当选视图崩溃 → 退位该条目 + chat 兜底接管（AppFrame 不知情）', async () => {
    const ctx = await makeCtx();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.slots.register('main', {
      id: 'webui-base-layout.perspective-host', component: Marker('chat'), order: 100,
      meta: { def: { id: 'chat', order: 100, active: () => true, component: Marker('chat') } },
    });
    ctx.slots.register('main', {
      id: 'third.boom', component: Boom, order: 50,
      meta: { def: { id: 'boom-view', order: 50, active: () => true, component: Boom } },
    });
    const { default: MainViewHost } = await import('../client/MainViewHost.vue');
    const un = mountWith(ctx, () => h(MainViewHost));
    await nextTick(); await nextTick();
    try {
      // 崩溃条目已退位（EntryErrorBoundary 上报 → abdicate）
      expect(ctx.slots.entries('main').some((e) => e.id === 'third.boom')).toBe(false);
      expect(ctx.slots.abdicatedOf('main').map((e) => e.id)).toContain('third.boom');
      // 重选举：chat 兜底接管主区（marker 在场 = 壳活着）
      expect(document.body.textContent).toContain('chat');
      // 全程无「席位内容已崩溃退出」死格面（有次位接任）
      expect(document.querySelector('[data-slot-error="main"]')).toBeNull();
      expect(errSpy).toHaveBeenCalled(); // 退位上报可见（fail-loud 语义保留）
    } finally {
      un(); errSpy.mockRestore();
    }
  });
});

describe('crash-hardening · 防线② 出口三态契约（dead cell 崩溃面）', () => {
  it('single 席位全退位 → 出口崩溃面占位（不再空白——root 白屏收口）', async () => {
    const ctx = await makeCtx();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.slots.register('root', { id: 'app-frame', component: Boom });
    const { default: SlotOutlet } = await import('ac-client-ui-renderer/client/SlotOutlet.vue');
    const un = mountWith(ctx, () => h(SlotOutlet, { name: 'root' }));
    await nextTick(); await nextTick();
    try {
      expect(ctx.slots.abdicatedOf('root').length).toBe(1); // 条目退位
      const face = document.querySelector('[data-slot-error="root"]');
      expect(face).not.toBeNull(); // 三态第三态：崩溃面（旧行为 = 空白）
      expect(face?.textContent).toContain('root');
    } finally {
      un(); errSpy.mockRestore();
    }
  });
});

describe('crash-hardening · 防线③ PerspectiveHost 视角级降级（async loader 类）', () => {
  it('async component loader 崩溃 → 就地错误卡（不退位壳、不上抛 root）', async () => {
    const ctx = await makeCtx();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerPerspective } = await import('../client/perspectives.ts');
    // 事故词形对位：defineAsyncComponent + 拒绝的 loader（Vue info 标签 =
    // 'async component loader'——2026-11-07 事故正是该类错误穿过过滤器）
    const BadAsync = defineAsyncComponent(() => Promise.reject(
      new TypeError("Failed to resolve module specifier 'ac-client-ui-conversation/client/ConversationView.vue'"),
    ));
    registerPerspective({ id: 'boom', label: 'Boom', order: 10, active: () => true, component: BadAsync });
    const { default: PerspectiveHost } = await import('../client/PerspectiveHost.vue');
    const un = mountWith(ctx, () => h(PerspectiveHost));
    await nextTick(); await nextTick(); await nextTick();
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    try {
      // 就地降级卡（视角粒度）
      expect(document.body.textContent).toContain('boom');
      expect(document.body.textContent).toContain('渲染崩溃');
      // 壳条目未退位、root 不知情
      expect(ctx.slots.abdicatedOf('main:perspective').length).toBe(0);
    } finally {
      un(); errSpy.mockRestore();
    }
  });
});
