// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-theme.test.ts —— theme 基础件验收（M27.2-2 出包：owning = ac-client-ui-theme/client）
// cr-43 ②：偏好三档（system 缺省 + light/dark 固定档 + 系统变化实时跟随）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createClient } from 'ac-client-runtime';
import { themeClientPlugin } from 'ac-client-ui-theme/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { useThemeStore } from 'ac-client-ui-theme/client/themeStore.ts';
import { resetClientRuntime } from '../src/runtime/clientRuntime';

/** 可控 matchMedia 桩：垫片 addEventListener 是 no-op，监听无从触发——替换之 */
function installMediaStub(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addEventListener: (_t: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  };
  window.matchMedia = () => mq as unknown as MediaQueryList;
  return {
    set(dark: boolean) {
      mq.matches = dark;
      const evt = { matches: dark, media: mq.media } as MediaQueryListEvent;
      for (const fn of listeners) fn(evt);
    },
  };
}

describe('M27.2 · theme 基础件（ctx.theme + 门面）', () => {
  it('服务装载：缺省 system 档；toggle 切出落定固定档 + html class + 持久化', async () => {
    localStorage.removeItem('agentchat.theme');
    installMediaStub(false);
    const ctx = await createClient();
    const fiber = await ctx.plugin(themeClientPlugin);
    const svc = ctx.theme;
    expect(svc).toBeDefined();

    expect(svc.preference.value).toBe('system');
    expect(svc.theme.value).toBe('light'); // 系统亮 → 生效亮
    svc.toggleTheme();
    expect(svc.theme.value).toBe('dark');
    expect(svc.preference.value).toBe('dark'); // 从 system 切出 = 固定档
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('agentchat.theme')).toBe('dark');
    await fiber.dispose();
  });

  it('跟随系统：followSystem 回档实时跟随；固定档不受系统切换扰', async () => {
    localStorage.removeItem('agentchat.theme');
    const media = installMediaStub(true);
    const ctx = await createClient();
    const fiber = await ctx.plugin(themeClientPlugin);
    const svc = ctx.theme;

    // system 档跟随系统变化（dark→light）
    expect(svc.theme.value).toBe('dark');
    media.set(false);
    expect(svc.theme.value).toBe('light');

    // 固定档不受扰
    svc.setTheme('dark');
    media.set(true);
    expect(svc.theme.value).toBe('dark');

    // 回 system：立即对齐当前系统值
    svc.followSystem();
    expect(svc.preference.value).toBe('system');
    expect(svc.theme.value).toBe('dark');
    await fiber.dispose();
  });

  it('存量偏好迁移：旧值 light/dark 仍为固定档（零迁移语义）', async () => {
    localStorage.setItem('agentchat.theme', 'dark');
    installMediaStub(false);
    const ctx = await createClient();
    const fiber = await ctx.plugin(themeClientPlugin);
    expect(ctx.theme.preference.value).toBe('dark');
    expect(ctx.theme.theme.value).toBe('dark');
    await fiber.dispose();
  });

  it('门面（runtime 在场）：useThemeStore 绑 ctx.theme.core 单一事实源', async () => {
    installMediaStub(false);
    const app = await bootWebuiRuntime();
    const fiber = await app.ctx.plugin(themeClientPlugin);
    setActivePinia(createPinia());
    const store = useThemeStore();
    store.toggleTheme();
    expect(app.ctx.theme.theme.value).toBe(store.theme); // 同一 Core
    await fiber.dispose();
  });

  it('门面（无 runtime）：独立 Core（单测语义不变）', () => {
    resetClientRuntime();
    installMediaStub(false);
    setActivePinia(createPinia());
    const store = useThemeStore();
    const before = store.theme;
    store.toggleTheme();
    expect(store.theme).not.toBe(before);
  });
});
