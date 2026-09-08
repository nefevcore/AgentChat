// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-usage.test.ts —— usage 域行 client 半边验收
//
// M28 P1 §4.1：域插件 owning = ac-client-ui-usage/client——
// overlay 席位贡献（Token 用量面板）+ 双向摘除。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { usageClientPlugin } from 'ac-client-ui-usage/client';

describe('M28 P1 · usage 域行 client（overlay 席位贡献）', () => {
  it('装载 → overlay 含 webui-domain-usage.panel（order 96）；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(usageClientPlugin);
    const entries = ctx.slots.entries('overlay');
    expect(entries.map((e) => e.id)).toContain('webui-domain-usage.panel');
    expect(entries.find((e) => e.id === 'webui-domain-usage.panel')?.order).toBe(96);
    await fiber.dispose();
    expect(ctx.slots.entries('overlay').map((e) => e.id)).not.toContain('webui-domain-usage.panel');
  });
});
