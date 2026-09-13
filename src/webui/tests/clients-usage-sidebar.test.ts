// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-usage-sidebar.test.ts —— P2 usage aux 选区验收
//（选区注册 + 意图通道 + keepAlive 语义）
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usageClientPlugin } from 'ac-client-ui-usage/client';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('P2 · usage 选区注册（usage 行）', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('行装载 → aux-sidebar 含 usage 条目（keepAlive + rail 恒可见）；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    setActivePinia(createPinia()); // boot 后重置——def 谓词读本用例 pinia
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    const fiber = await ctx.plugin(usageClientPlugin);
    expect(ids('aux-sidebar')).toContain('webui-domain-usage.sidebar');
    const entry = ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-domain-usage.sidebar')!;
    const def = entry.meta?.def as {
      id: string; keepAlive?: boolean; available?: () => boolean; active: () => boolean;
      rail?: { icon: string; title: string };
    };
    expect(def.id).toBe('usage');
    expect(def.keepAlive).toBe(true); // 图表状态跨让位保留
    expect(def.available?.() ?? true).toBe(true); // 恒可见（无上下文门槛）
    expect(def.rail).toEqual({ icon: 'chart-pie', title: 'Token 用量', activate: expect.any(Function) });
    // active 谓词 = 显式选区驱动：auxPanel 为 'usage' 时真、否则假
    expect(def.active()).toBe(false);
    const ui = useUiStore();
    ui.selectAuxPanel('usage');
    expect(def.active()).toBe(true);
    await fiber.dispose();
    expect(ids('aux-sidebar')).not.toContain('webui-domain-usage.sidebar');
  });

  it('意图通道：openTokenUsage（宽屏）→ usageIntent++；意图消费（TokenUsageHost 组件）切选区展开', async () => {
    const { ctx } = await bootWebuiRuntime();
    await ctx.plugin(usageClientPlugin);
    // 挂载 overlay 宿主（意图消费面——AppFrame 常驻；测试直接 mount 同款）
    const { createApp, h, nextTick } = await import('vue');
    const { CLIENT_CONTEXT_KEY } = await import('ac-client-runtime');
    const TokenUsageHost = (await import('ac-client-ui-usage/client/TokenUsageHost.vue')).default;
    const pinia = createPinia();
    setActivePinia(pinia);
    const host = document.createElement('div');
    const app = createApp({ render: () => h(TokenUsageHost) });
    app.use(pinia);
    app.provide(CLIENT_CONTEXT_KEY, ctx);
    app.mount(host);
    await nextTick();

    const ui = useUiStore();
    ui.openTokenUsage(); // 宽屏（1024 > 768）
    expect(ui.auxIntent).toBe(1); // 通用意图 seq
    expect(ui.auxIntentPanel).toBe('usage');
    expect(ui.tokenUsageVisible).toBe(false); // 宽屏不开 Modal
    await nextTick();
    expect(ui.auxPanel).toBe('usage'); // 意图消费 → 显式选区
    expect(ui.auxVisible).toBe(true); // 区域展开
    // 铺开舒适宽：min(840, 1024-88-320=616) = 616（1024 屏钳制）
    expect(ui.auxWidth).toBe(616);
    app.unmount();
  });

  it('窄屏（≤768）：openTokenUsage → Modal 直开（原行为不变）', async () => {
    setActivePinia(createPinia());
    const ui = useUiStore();
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
    try {
      ui.openTokenUsage();
      expect(ui.tokenUsageVisible).toBe(true);
      expect(ui.auxIntent).toBe(0); // 不写意图
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    }
  });
});
