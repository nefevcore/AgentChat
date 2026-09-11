// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-plugin-registry.test.ts —— plugin-registry 域行
// client 半边验收（M28 P2 §5.2：settings:section 贡献 + 双向摘除；
// 2026-11 左树数据化：叶随贡献退场 + label/order 断言）
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { pluginRegistryClientPlugin } from 'ac-client-ui-plugin-registry/client';
import { deriveSectionLeaves } from 'ac-client-ui-settings/client/sectionTree.ts';

describe('M28 P2 · plugin-registry 域行 client（settings:section 插件库节贡献）', () => {
  it('装载 → pluginLibrary 节与左树叶在场；卸载 → 叶与节同步消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const leaves = () => deriveSectionLeaves(ctx.slots.entries('settings:section'));
    const fiber = await ctx.plugin(pluginRegistryClientPlugin);
    expect(sections()).toContain('pluginLibrary');
    expect(leaves()).toContainEqual({ id: 'pluginLibrary', label: '插件库' });
    expect(ctx.slots.entries('settings:section').find((e) => e.meta?.section === 'pluginLibrary')?.order).toBe(40);
    await fiber.dispose();
    expect(sections()).not.toContain('pluginLibrary');
    expect(leaves().map((l) => l.id)).not.toContain('pluginLibrary');
  });
});
