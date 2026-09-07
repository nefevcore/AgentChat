// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-groups.test.ts —— group 域行 client 半边验收
//
// M27.1：域插件 owning = ac-client-ui-group/client（D19 改裁——前端
// 行独立包；协调走服务面互调：ctx.sessions / ctx.roster）。
// 「域投影 + ctx.groups 服务面」+ 可摘除性（D19：卸载域插件 →
// 帧订阅回收 + ctx.groups 消失 + 群消费面空态）。宿主半边 boot graph
// 声明验收见 ac-client-ui-group/tests（todo/jobs 同款）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient, type Fiber } from 'ac-client-runtime';
import { groupClientPlugin } from 'ac-client-ui-group/client';
import { rosterClientPlugin } from 'ac-client-ui-agents/client';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { stubRpc } from './lib/rpcStub';

/** 域行 client 装载前提：rpc 桩 + conversation（sessions）+ roster */
async function bootDomainRuntime() {
  const boot = await bootWebuiRuntime();
  await stubRpc(boot.ctx);
  await boot.ctx.plugin(rosterClientPlugin);
  return boot;
}

describe('S3-1b · group 域行 client（域投影 + ctx.groups 服务面）', () => {
  it('服务装载：ctx.groups 可解析；创建弹窗开合 + 列表 reactive', async () => {
    const boot = await bootDomainRuntime();
    const fiber: Fiber = await boot.ctx.plugin(groupClientPlugin);
    const svc = boot.ctx.groups;
    expect(svc).toBeDefined();
    expect(svc.groups.value).toEqual([]);
    svc.openCreateGroup();
    expect(svc.showCreateGroup.value).toBe(true);
    svc.closeCreateGroup();
    expect(svc.showCreateGroup.value).toBe(false);
    // 列表 reactive（group/message-posted 重排路径的数据面）
    svc.groups.value = [
      { group_id: 'g1', name: 'A', participants: [], created_at: 0, lastActivity: 1 } as never,
      { group_id: 'g2', name: 'B', participants: [], created_at: 0, lastActivity: 5 } as never,
    ];
    svc.handleGroupMessage({ group_id: 'g1' });
    expect(svc.groups.value[0].group_id).toBe('g1'); // 活跃时间刷新后重排居首
    expect(svc.groups.value[0].lastActivity ?? 0).toBeGreaterThanOrEqual(5);
    await fiber.dispose();
  });

  it('选中协调（服务面互调）：selectGroup → roster 清选 + feed 活跃群 + lastContext', async () => {
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(groupClientPlugin);
    boot.ctx.roster.selectAgent('a1');
    boot.ctx.groups.selectGroup('g9');
    expect(boot.ctx.roster.activeAgentId.value).toBe(''); // 互斥清选（服务面）
    expect(boot.ctx.groups.activeGroupId.value).toBe('g9');
    expect(boot.ctx.sessions.feed.activeGroupId.value).toBe('g9'); // feed 协调面
    boot.ctx.groups.deselectGroup();
    expect(boot.ctx.sessions.feed.activeGroupId.value).toBe('');
    await fiber.dispose();
  });

  it('可摘除性（D19）：fiber dispose → ctx.groups 消失、幂等 init 不复挂订阅', async () => {
    const boot = await bootDomainRuntime();
    const fiber = await boot.ctx.plugin(groupClientPlugin);
    const svc = boot.ctx.groups;
    svc.init();
    svc.init(); // 幂等（二次只刷新列表）
    await fiber.dispose(); // 卸载：服务 + 帧订阅一并回收
    expect((boot.ctx as { groups?: unknown }).groups).toBeUndefined();
  });

  it('未装载域件的 runtime → useClientContext()?.groups = undefined（群消费面空态）', async () => {
    const boot = await bootWebuiRuntime(); // 不装 group 域件
    expect((boot.ctx as { groups?: unknown }).groups).toBeUndefined();
  });
});
