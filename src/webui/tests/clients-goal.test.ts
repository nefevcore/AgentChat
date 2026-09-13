// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-goal.test.ts —— goal 域行 client 半边验收
//
// M28 P1 §4.1：域插件 owning = ac-client-ui-goal/client——
// tool-card:result-view（id 'goal'）+ conversation:dock-widget
//（id 'goal'，order 20——M30 D5 改名）双席位贡献 + 双向摘除。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { goalClientPlugin } from 'ac-client-ui-goal/client';

describe('M28 P1 · goal 域行 client（双席位贡献）', () => {
  it('tool-card:result-view 贡献（id goal）：装载 → resolve 命中；卸载 → 回落文本渲染', async () => {
    const { ctx } = await bootWebuiRuntime();
    const { resolveToolResultView } = await import('../src/core/registry/toolResultViews');
    const fiber = await ctx.plugin(goalClientPlugin);
    expect(ctx.slots.entries('tool-card:result-view').map((e) => e.id)).toContain('goal');
    expect(resolveToolResultView('goal')).toBeTruthy();
    await fiber.dispose();
    expect(resolveToolResultView('goal')).toBeNull();
  });

  it('conversation:dock-widget 贡献（id goal，order 50 = dock 序重排后目标垫底——任务(40) 后）：卸载 → 消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    const fiber = await ctx.plugin(goalClientPlugin);
    const entries = ctx.slots.entries('conversation:dock-widget');
    expect(entries.map((e) => e.id)).toContain('goal');
    expect(entries.find((e) => e.id === 'goal')?.order).toBe(50);
    await fiber.dispose();
    expect(ctx.slots.entries('conversation:dock-widget').map((e) => e.id)).not.toContain('goal');
  });
});
