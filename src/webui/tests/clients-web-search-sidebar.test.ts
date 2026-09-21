// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-web-search-sidebar.test.ts —— web 搜索
// aux 选区验收（web 行：webui-domain-web.search）
//
// 选区注册 + rail 资产 + active 域内意愿驱动 + tab 状态机。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { webCardClientPlugin } from 'ac-client-ui-web/client';
import { useWebSearchTabsStore, MAX_SEARCH_TABS } from 'ac-client-ui-web/client/searchTabs.ts';
import { useUiStore } from 'ac-client-ui-layout/client/uiStore.ts';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('web 搜索 aux 选区注册（web 行）', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('行装载 → aux-sidebar 含 search 条目（available=false 空 tab）；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    setActivePinia(createPinia()); // boot 后重置——def 谓词读本用例 pinia
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    const fiber = await ctx.plugin(webCardClientPlugin);
    expect(ids('aux-sidebar')).toContain('webui-domain-web.search');
    const entry = ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-domain-web.search')!;
    const def = entry.meta?.def as {
      id: string; order?: number; comfyWidth?: number | 'half';
      available: () => boolean; active: () => boolean;
      rail?: { icon: string; title: string; activate: () => void };
    };
    expect(def.id).toBe('search');
    expect(def.comfyWidth).toBe(480); // 搜索列表舒适宽
    expect(def.available()).toBe(false); // 无 tab：rail 按钮不露
    // 开 tab 后 available/active 翻真（panelOpen 随 openTab 置真）
    const tabs = useWebSearchTabsStore();
    tabs.openTab({ query: 'agentchat', results: [] });
    expect(def.available()).toBe(true);
    expect(def.active()).toBe(true);
    // rail 资产
    expect(def.rail).toMatchObject({ icon: 'search', title: '网络搜索' });
    await fiber.dispose();
    expect(ids('aux-sidebar')).not.toContain('webui-domain-web.search');
  });

  it('searchTabs 状态机：同 query 复用刷新（不开新 tab）+ LRU 淘汰 + 全关收面板', () => {
    const tabs = useWebSearchTabsStore();
    const mk = (q: string) => ({ query: q, results: [{ title: q, url: 'https://a/' + q, content: 'c', score: 1 }] });
    tabs.openTab(mk('q1'));
    tabs.openTab(mk('q2'));
    expect(tabs.count).toBe(2);
    expect(tabs.activeKey).toBe('q2');
    // 同 query 再开 = 刷新既有 tab（内容替换 + 激活），不开第三个
    tabs.openTab({ ...mk('q1'), answer: '更新后的摘要' });
    expect(tabs.count).toBe(2);
    expect(tabs.activeKey).toBe('q1');
    expect(tabs.activeTab?.answer).toBe('更新后的摘要');
    // LRU：超上限淘汰最旧非激活
    for (let i = 0; i < MAX_SEARCH_TABS + 3; i++) tabs.openTab(mk('q' + (10 + i)));
    expect(tabs.count).toBe(MAX_SEARCH_TABS);
    // 关闭让位右邻优先；全关 → panelOpen 收
    expect(tabs.panelOpen).toBe(true);
    while (tabs.count > 0) tabs.closeTab(tabs.tabs[0]!.key);
    expect(tabs.count).toBe(0);
    expect(tabs.panelOpen).toBe(false);
    expect(tabs.activeKey).toBe('');
  });
});
