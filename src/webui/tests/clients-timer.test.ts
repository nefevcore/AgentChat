// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-timer.test.ts —— timer 域行 client 半边验收
//
// M28 P2 settings 退化收口：全局定时任务节（sys.timer）经
// settings:section 选举席贡献 + 双向摘除（P1-5 裁决注记 2 落位）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { timerClientPlugin } from 'ac-client-ui-timer/client';

describe('M28 P2 · timer 域行 client（全局定时任务节贡献）', () => {
  it('装载 → sys.timer 节贡献在场；卸载 → 消失（内容区空态）', async () => {
    const { ctx } = await bootWebuiRuntime(); // settings 在场 → 选举席已声明
    const sections = () => ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const fiber = await ctx.plugin(timerClientPlugin);
    expect(sections()).toContain('sys.timer');
    await fiber.dispose();
    expect(sections()).not.toContain('sys.timer');
  });
});
