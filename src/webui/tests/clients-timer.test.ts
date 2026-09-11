// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-timer.test.ts —— timer 域行 client 半边验收
//
// M28 P2 settings 退化收口：全局定时任务节（sys.timer）经
// settings:section 选举席贡献 + 双向摘除（P1-5 裁决注记 2 落地）。
// 2026-11 左树数据化：贡献携带 meta.label + 顶层 order——左树叶与
// 节同源派生，卸载叶/节同步退场（D19 整枝退场）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { timerClientPlugin } from 'ac-client-ui-timer/client';
import { deriveSectionLeaves } from 'ac-client-ui-settings/client/sectionTree.ts';

describe('M28 P2 · timer 域行 client（全局定时任务节贡献）', () => {
  it('装载 → sys.timer 节与左树叶在场（label/order 随贡献）；卸载 → 叶与节同步消失', async () => {
    const { ctx } = await bootWebuiRuntime(); // settings 在场 → 选举席已声明
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const leaves = () => deriveSectionLeaves(ctx.slots.entries('settings:section'));
    const fiber = await ctx.plugin(timerClientPlugin);
    expect(sections()).toContain('sys.timer');
    expect(leaves()).toContainEqual({ id: 'sys.timer', label: '定时任务' });
    expect(ctx.slots.entries('settings:section').find((e) => e.meta?.section === 'sys.timer')?.order).toBe(50);
    await fiber.dispose();
    expect(sections()).not.toContain('sys.timer');
    expect(leaves().map((l) => l.id)).not.toContain('sys.timer');
  });
});
