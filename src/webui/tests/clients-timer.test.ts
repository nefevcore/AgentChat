// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-timer.test.ts —— timer 域行 client 半边验收
//
// M28 P2 settings 退化收口（历史形态）：全局定时任务节（sys.timer）
// 经 settings:section 选举席贡献。A3 起：定时任务聚合 aux 选区是唯一
// 全局任务入口——sys.timer 节撤（与 aux 面板同组件纯冗余）；本测试
// 改锚 aux 选区注册 + sys.timer 节缺席（冗余消除回归锚）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { timerClientPlugin } from 'ac-client-ui-timer/client';

describe('A3 · timer 域行 client（timers aux 选区——sys.timer 节撤）', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('装载 → timers aux 选区在场（keepAlive + rail）；settings 无 sys.timer 节（冗余消除）；卸载 → 选区消失', async () => {
    const { ctx } = await bootWebuiRuntime();
    setActivePinia(createPinia()); // def 谓词读本用例 pinia
    const ids = (key: string) => ctx.slots.entries(key).map((e) => e.id);
    const fiber = await ctx.plugin(timerClientPlugin);
    expect(ids('aux-sidebar')).toContain('webui-domain-timer.sidebar');
    const entry = ctx.slots.entries('aux-sidebar').find((e) => e.id === 'webui-domain-timer.sidebar')!;
    const def = entry.meta?.def as {
      id: string; keepAlive?: boolean; active: () => boolean;
      rail?: { icon: string; title: string };
    };
    expect(def.id).toBe('timers');
    expect(def.keepAlive).toBe(true);
    expect(def.rail).toEqual({ icon: 'alarm-clock', title: '定时任务', activate: expect.any(Function) });
    // active 谓词 = 显式选区驱动
    expect(def.active()).toBe(false);
    const { useUiStore } = await import('ac-client-ui-layout/client/uiStore.ts');
    useUiStore().selectAuxPanel('timers');
    expect(def.active()).toBe(true);
    // sys.timer 节已撤（唯一入口 = aux 选区）
    expect(ctx.slots.entries('settings:section').map((e) => e.meta?.section)).not.toContain('sys.timer');
    await fiber.dispose();
    expect(ids('aux-sidebar')).not.toContain('webui-domain-timer.sidebar');
  });
});
