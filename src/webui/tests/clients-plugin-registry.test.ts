// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-plugin-registry.test.ts —— plugin-registry 域行
// client 半边验收（M28 P2 §5.2：settings:section 贡献 + 双向摘除）
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { pluginRegistryClientPlugin } from 'ac-client-ui-plugin-registry/client';

describe('M28 P2 · plugin-registry 域行 client（settings:section 插件库节贡献）', () => {
  it('装载 → pluginLibrary 节贡献在场；卸载 → 消失（内容区空态）', async () => {
    const { ctx } = await bootWebuiRuntime();
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const fiber = await ctx.plugin(pluginRegistryClientPlugin);
    expect(sections()).toContain('pluginLibrary');
    await fiber.dispose();
    expect(sections()).not.toContain('pluginLibrary');
  });
});
