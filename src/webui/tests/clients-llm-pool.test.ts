// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-llm-pool.test.ts —— llm-pool 域行 client 半边验收
//
// M28 P2 §5.2：域插件 owning = ac-client-ui-llm-pool/client——
// settings:section 选举席贡献（llmPools/searchPools 两节）+ 双向摘除。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { llmPoolClientPlugin } from 'ac-client-ui-llm-pool/client';

describe('M28 P2 · llm-pool 域行 client（settings:section 双节贡献）', () => {
  it('装载 → llmPools/searchPools 两节贡献在场；卸载 → 消失（内容区空态）', async () => {
    const { ctx } = await bootWebuiRuntime(); // settings 在场 → 选举席已声明
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const fiber = await ctx.plugin(llmPoolClientPlugin);
    expect(sections()).toContain('llmPools');
    expect(sections()).toContain('searchPools');
    await fiber.dispose();
    expect(sections()).not.toContain('llmPools');
    expect(sections()).not.toContain('searchPools');
  });
});
