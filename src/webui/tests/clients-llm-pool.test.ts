// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-llm-pool.test.ts —— llm-pool 域行 client 半边验收
//
// M28 P2 §5.2：域插件 owning = ac-client-ui-llm-pool/client——
// settings:section 选举席贡献 + 双向摘除。
// 2026-11 左树数据化 + 行拆分：贡献携带 meta.label + 顶层 order——
// 左树叶与节同源派生，卸载叶/节同步退场（D19 整枝退场）；搜索引擎节
// 已拆往 ac-client-ui-search-pool（见 clients-search-pool.test.ts），
// 本行收窄为 llmPools 单节。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { llmPoolClientPlugin } from 'ac-client-ui-llm-pool/client';
import { deriveSectionLeaves } from 'ac-client-ui-settings/client/sectionTree.ts';

describe('M28 P2 · llm-pool 域行 client（settings:section 模型池节贡献）', () => {
  it('装载 → llmPools 节与左树叶在场（label/order 随贡献）；卸载 → 叶与节同步消失', async () => {
    const { ctx } = await bootWebuiRuntime(); // settings 在场 → 选举席已声明
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const leaves = () => deriveSectionLeaves(ctx.slots.entries('settings:section'));
    const orderOf = (id: string) => ctx.slots.entries('settings:section').find((e) => e.meta?.section === id)?.order;
    const fiber = await ctx.plugin(llmPoolClientPlugin);
    expect(sections()).toContain('llmPools');
    expect(leaves()).toContainEqual({ id: 'llmPools', label: '模型管理' });
    expect(orderOf('llmPools')).toBe(20);
    // 行拆分后本行只贡献 llmPools——searchPools 不在本行贡献面
    expect(sections()).not.toContain('searchPools');
    await fiber.dispose();
    expect(sections()).not.toContain('llmPools');
    expect(leaves().map((l) => l.id)).not.toContain('llmPools');
  });
});
