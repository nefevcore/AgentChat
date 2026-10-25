// @vitest-environment jsdom
// ============================================================
// theme-id.test.ts —— 色板主题 id 轴（B2 cr-693：data-theme 选择轴——
// ui-tree §2「选择轴预留 data-theme id 升格」的实装锁）。
// 明暗档（dark/light）与色板 id 正交：id 只走 data-theme 属性通道，
// classic = 内置缺省（撤属性）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';

describe('B2 · 色板主题 id 轴', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('缺省 classic：不写 data-theme 属性（命中内置 :root/html.dark 缺省）', async () => {
    const { ThemeCore } = await import('../client/index.ts');
    const core = new ThemeCore();
    expect(core.themeId.value).toBe('classic');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('登记 + 切换：data-theme 属性随动 + 持久化 + 明暗 class 不受扰', async () => {
    const { ThemeCore, registerThemeId } = await import('../client/index.ts');
    registerThemeId('midnight');
    const core = new ThemeCore();
    core.setThemeId('midnight');
    expect(core.themeId.value).toBe('midnight');
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(localStorage.getItem('agentchat.theme.id')).toBe('midnight');
    // 明暗档照常工作（正交轴）
    core.setTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    // 回 classic：撤属性
    core.setThemeId('classic');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('未登记 id 拒切（主题包缺席不半途换肤）+ 登记面词形过滤', async () => {
    const { ThemeCore, registerThemeId } = await import('../client/index.ts');
    const core = new ThemeCore();
    core.setThemeId('ghost');
    expect(core.themeId.value).toBe('classic');
    // 词形过滤：非法 id 不入登记面（listThemeIds 不含它，且拒切）
    registerThemeId('Bad_Id');
    const core2 = new ThemeCore();
    core2.setThemeId('Bad_Id');
    expect(core2.themeId.value).toBe('classic');
    expect(core2.listThemeIds()).not.toContain('Bad_Id');
  });

  it('重启恢复：持久化 themeId 读回并应用 data-theme', async () => {
    localStorage.setItem('agentchat.theme.id', 'midnight');
    const { ThemeCore } = await import('../client/index.ts');
    const core = new ThemeCore();
    expect(core.themeId.value).toBe('midnight');
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
  });
});
