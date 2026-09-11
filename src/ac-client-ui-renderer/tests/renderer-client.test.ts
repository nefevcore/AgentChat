// @vitest-environment jsdom
// ============================================================
// ac-client-ui-renderer/tests/renderer-client.test.ts —— client 半边验收
//（M27.2-2：ctx.vueRenderer 服务面 + markdown 管线资产〔useMarkdown
// 模块求值期读 document 主题态——需 jsdom〕）
// ============================================================
import { describe, it, expect } from 'vitest';

describe('M27.2 · ac-client-ui-renderer client 半边（服务面 + markdown 管线资产）', () => {
  it('插件装载 → ctx.vueRenderer 服务（boot-once install + renderSlot 面）', async () => {
    const { createClient } = await import('ac-client-runtime');
    const ctx = await createClient();
    const { rendererClientPlugin } = await import('../client/index.ts');
    const fiber = await ctx.plugin(rendererClientPlugin);
    expect(ctx.vueRenderer).toBeDefined();
    const vnode = ctx.vueRenderer.renderSlot('root');
    expect(vnode).toBeDefined(); // root 空态也产出 vnode（DEV 诊断/空 Outlet）
    await fiber.dispose();
    expect((ctx as { vueRenderer?: unknown }).vueRenderer).toBeUndefined();
  });

  it('markdown 管线资产在场：useMarkdown 渲染基本 markdown', async () => {
    const { useMarkdown } = await import('../client/useMarkdown.ts');
    const { render } = useMarkdown();
    const html = render('**加粗**');
    expect(String(html)).toContain('<');
  });

  // 注记：M30 D3 的 useSeatOccupancy 门控原语随主区/aux 选举化失去全部
  // 生产消费方（占用门控内在于选举），同批除役——git 史可溯。
});
