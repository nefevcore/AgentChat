// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-theme.test.ts —— theme 基础件验收（M27.2-2 出包：owning = ac-client-ui-theme/client）
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createClient } from 'ac-client-runtime';
import { themeClientPlugin } from 'ac-client-ui-theme/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { useThemeStore } from '../src/stores/theme';
import { resetClientRuntime } from '../src/runtime/clientRuntime';

describe('M27.2 · theme 基础件（ctx.theme + 门面）', () => {
  it('服务装载：ctx.theme 可解析；toggle 翻转 + html class 应用 + localStorage 持久化', async () => {
    localStorage.removeItem('agentchat.theme');
    const ctx = await createClient();
    const fiber = await ctx.plugin(themeClientPlugin);
    const svc = ctx.theme;
    expect(svc).toBeDefined();

    const initial = svc.theme.value;
    svc.toggleTheme();
    const flipped = svc.theme.value;
    expect(flipped).not.toBe(initial);
    expect(document.documentElement.classList.contains(flipped)).toBe(true);
    expect(localStorage.getItem('agentchat.theme')).toBe(flipped);
    await fiber.dispose();
  });

  it('门面（runtime 在场）：useThemeStore 绑 ctx.theme.core 单一事实源', async () => {
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
    setActivePinia(createPinia());
    const store = useThemeStore();
    const before = store.theme;
    store.toggleTheme();
    expect(store.theme).not.toBe(before);
  });
});
