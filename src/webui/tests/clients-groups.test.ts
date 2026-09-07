// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-groups.test.ts —— S2 group 域插件验收
//
// 「域投影 + ctx.groups 服务面」+ 可摘除性（D19/S2：卸载域插件 →
// 帧订阅回收 + ctx.groups 消失 + 群消费面空态）。
// 选中协调（feed/agents）在 pinia 面下验证（feed/chat 收尾时改服务面互调）。
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createClient, type Fiber } from 'ac-client-runtime';
import { groupsDomainPlugin } from '../src/clients/groups';
import { bootWebuiRuntime } from './lib/webuiBoot';

describe('S2 · group 域插件（域投影 + ctx.groups 服务面）', () => {
  beforeEach(() => {
    setActivePinia(createPinia()); // 选中协调经 pinia store（过渡期）
  });

  it('服务装载：ctx.groups 可解析；创建弹窗开合 + 列表 reactive', async () => {
    const ctx = await createClient();
    const fiber: Fiber = await ctx.plugin(groupsDomainPlugin);
    const svc = ctx.groups;
    expect(svc).toBeDefined();
    expect(svc.groups.value).toEqual([]);
    svc.openCreateGroup();
    expect(svc.showCreateGroup.value).toBe(true);
    svc.closeCreateGroup();
    expect(svc.showCreateGroup.value).toBe(false);
    // 列表 reactive（group/message-posted 重排路径的数据面）
    svc.groups.value = [
      { group_id: 'g1', name: 'A', members: [], lastActivity: 1 } as never,
      { group_id: 'g2', name: 'B', members: [], lastActivity: 5 } as never,
    ];
    svc.handleGroupMessage({ group_id: 'g1' });
    expect(svc.groups.value[0].group_id).toBe('g1'); // 活跃时间刷新后重排居首
    expect(svc.groups.value[0].lastActivity ?? 0).toBeGreaterThanOrEqual(5);
    await fiber.dispose();
  });

  it('可摘除性（D19/S2）：fiber dispose → ctx.groups 消失、幂等 init 不复挂订阅', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(groupsDomainPlugin);
    const svc = ctx.groups;
    svc.init();
    svc.init(); // 幂等（二次只刷新列表）
    await fiber.dispose(); // 卸载：服务 + 帧订阅一并回收
    expect((ctx as { groups?: unknown }).groups).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.groups = undefined（群消费面空态）', async () => {
    const { ctx } = await bootWebuiRuntime(); // 不装 group 域件
    expect((ctx as { groups?: unknown }).groups).toBeUndefined();
  });
});
