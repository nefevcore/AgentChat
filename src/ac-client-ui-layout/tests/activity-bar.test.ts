// ============================================================
// ac-client-ui-layout/tests/activity-bar.test.ts —— 活动栏
// 两壳随件资产验收（2026-11 自 ac-client-ui-sidebar 行归并壳件）
//
// 原 sidebar 行的宿主半边（ui-sidebar boot graph 声明/卸载级联）随行
// 消亡——归并后由 ui-layout 行承担（见 layout-row.test.ts）；此处保留
// 归并资产的数据面锁：activityBarActions 解析语义（ctx 参数化——注册表
// order 轴）。node 环境（jsdom 的 URL 垫片与 node:url 不兼容）。
// ============================================================
import { describe, it, expect } from 'vitest';

describe('归并资产 · activityBarActions 解析（活动栏插件动作位）', () => {
  it('entries → def 视图（meta.def 原样携带；order 缺省 100 升序）', async () => {
    const { createClient } = await import('ac-client-runtime');
    const ctx = await createClient();
    ctx.slots.declare({ key: 'activity-bar:plugin-actions', kind: 'list' });
    ctx.slots.register('activity-bar:plugin-actions', {
      id: 'b', component: { render: () => null }, order: 200,
      meta: { def: { id: 'b', label: 'B', icon: 'i', onClick: () => {} } },
    });
    ctx.slots.register('activity-bar:plugin-actions', {
      id: 'a', component: { render: () => null },
      meta: { def: { id: 'a', label: 'A', icon: 'i', order: 50, onClick: () => {} } },
    });
    const { useActivityBarActions } = await import('../client/activityBarActions.ts');
    const sorted = useActivityBarActions(ctx);
    expect(sorted.value.map((a) => a.id)).toEqual(['a', 'b']); // order 升序（50 < 200）
    // runtime 缺席 → 空清单
    expect(useActivityBarActions(undefined).value).toEqual([]);
  });
});
