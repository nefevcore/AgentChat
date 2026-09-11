// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-search-pool.test.ts —— search-pool 域行 client
// 半边验收（2026-11 自 ui-llm-pool 拆分：searchPools 节随行迁移 +
// 双向摘除 + 左树叶同源派生断言）
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { searchPoolClientPlugin } from 'ac-client-ui-search-pool/client';
import { deriveSectionLeaves } from 'ac-client-ui-settings/client/sectionTree.ts';

describe('2026-11 · search-pool 域行 client（settings:section 搜索引擎节贡献）', () => {
  it('装载 → searchPools 节与左树叶在场（label/order 随贡献）；卸载 → 叶与节同步消失', async () => {
    const { ctx } = await bootWebuiRuntime(); // settings 在场 → 选举席已声明
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const leaves = () => deriveSectionLeaves(ctx.slots.entries('settings:section'));
    const fiber = await ctx.plugin(searchPoolClientPlugin);
    expect(sections()).toContain('searchPools');
    expect(leaves()).toContainEqual({ id: 'searchPools', label: '搜索引擎' });
    expect(ctx.slots.entries('settings:section').find((e) => e.meta?.section === 'searchPools')?.order).toBe(30); // 叶序：llmPools(20) 与 pluginLibrary(40) 之间
    await fiber.dispose();
    expect(sections()).not.toContain('searchPools');
    expect(leaves().map((l) => l.id)).not.toContain('searchPools');
  });
});
