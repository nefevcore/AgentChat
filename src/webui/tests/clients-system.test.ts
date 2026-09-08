// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-system.test.ts —— system 域行 client 半边验收
//
// M28 P1 §4.1：域插件 owning = ac-client-ui-system/client——
// overlay 席位贡献（版本弹窗）+ 双向摘除。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { systemClientPlugin } from 'ac-client-ui-system/client';

describe('M28 P1 · system 域行 client（overlay 席位贡献）', () => {
  it('装载 → overlay 含 webui-domain-system.version-dialog（order 97）；卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(systemClientPlugin);
    const entries = ctx.slots.entries('overlay');
    expect(entries.map((e) => e.id)).toContain('webui-domain-system.version-dialog');
    expect(entries.find((e) => e.id === 'webui-domain-system.version-dialog')?.order).toBe(97);
    await fiber.dispose();
    expect(ctx.slots.entries('overlay').map((e) => e.id)).not.toContain('webui-domain-system.version-dialog');
  });
});
