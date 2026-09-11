// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-roster.test.ts —— roster 域行 client 半边验收
//
// M27 S3-1b：域插件自 webui/src/clients/roster.ts 迁 ac-client-ui-agents/client
//（行包双半边，D19）。§0.3 层 2 身份面（ctx.roster）+ 取用口
// useRosterCore（M28 §4.2：runtime 在场 → ctx.roster.core 单一事实源；
// 缺席 → 模块级回落单例）+ 可摘除性。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createClient } from 'ac-client-runtime';
import { rosterClientPlugin, RosterCore } from 'ac-client-ui-agents/client';
import { useRosterCore } from 'ac-client-ui-agents/client/rosterAccess.ts';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { resetClientRuntime } from '../src/runtime/clientRuntime';
import { stubRpc } from './lib/rpcStub';
import { deriveSectionLeaves } from 'ac-client-ui-settings/client/sectionTree.ts';

describe('S3-1b · roster 域行 client（层 2 身份面 + agents 域写面）', () => {
  it('服务装载：ctx.roster 可解析；名册排序 + 显示名解析（列表 → 预设 → id 兜底）', async () => {
    const ctx = await createClient();
    await stubRpc(ctx);
    const fiber = await ctx.plugin(rosterClientPlugin);
    const roster = ctx.roster;
    expect(roster).toBeDefined();

    roster.setAgents([
      { id: 'a1', name: '甲', lastActivity: 1 } as never,
      { id: 'a2', name: '乙', lastActivity: 9 } as never,
    ]);
    expect(roster.agents.value.map((a) => a.id)).toEqual(['a2', 'a1']); // 活跃度排序
    expect(roster.getAgentName('a1')).toBe('甲');
    expect(roster.getAgentName('preset-x')).toBe('preset-x'); // id 兜底
    roster.presets.value = [{ id: 'preset-x', name: '预设甲', default: true } as never];
    expect(roster.getAgentName('preset-x')).toBe('预设甲');
    expect(roster.defaultPresetId.value).toBe('preset-x');
    expect(roster.isPreset('preset-x')).toBe(true);
    await fiber.dispose();
  });

  it('取用口（runtime 在场）：useRosterCore 绑 ctx.roster.core——单一事实源', async () => {
    const app = await bootWebuiRuntime(); // 设 runtime 单例（rpc 缺省离线桩）
    const fiber = await app.ctx.plugin(rosterClientPlugin); // roster 域件挂册
    const core = useRosterCore();
    core.setAgents([{ id: 'z9', name: '共享', lastActivity: 1 } as never]);
    expect(app.ctx.roster.agents.value.map((a) => a.id)).toEqual(['z9']); // 同一 Core
    await fiber.dispose();
  });

  it('取用口（无 runtime）：回落单例——同文件多次取用同实例（「同测试内同实例」语义）', async () => {
    resetClientRuntime();
    const s1 = useRosterCore();
    s1.setAgents([{ id: 'q1', name: '共享单例', lastActivity: 1 } as never]);
    expect(s1.getAgentName('q1')).toBe('共享单例');
    // 再次取用 → 同一实例（feed/chat 核心与断言同源）
    expect(useRosterCore().agents.value.map((a) => a.id)).toEqual(['q1']);
    // 显式 new RosterCore() → 独立实例（测试隔离路径）
    expect(new RosterCore().agents.value).toEqual([]);
  });

  it('可摘除性（D19）：fiber dispose → ctx.roster 消失；取用口回落单例', async () => {
    const ctx = await createClient();
    await stubRpc(ctx);
    const fiber = await ctx.plugin(rosterClientPlugin);
    expect(ctx.roster).toBeDefined();
    await fiber.dispose();
    expect((ctx as { roster?: unknown }).roster).toBeUndefined();
    const core = new RosterCore();
    expect(core.agents.value).toEqual([]); // Core 独立可用（取用口回落路径）
  });

  it('M28 P2 · agents 名册面板贡献：装载 → primary-sidebar:domain 含 agents 面板；卸载 → 消失', async () => {
    const boot = await bootWebuiRuntime(); // layout 壳在场 → 选举席已声明
    const panelOf = (id: string) => boot.ctx.slots.entries('primary-sidebar:domain').find((e) => e.meta?.panel === id);
    const fiber = await boot.ctx.plugin(rosterClientPlugin);
    expect(panelOf('agents')?.id).toBe('webui-domain-agents.panel');
    await fiber.dispose();
    expect(panelOf('agents')).toBeUndefined();
  });

  it('M28 P2 · Agent 设置节贡献（settings:section）：装载 → agents 节与左树叶在场；卸载 → 同步消失', async () => {
    const boot = await bootWebuiRuntime(); // settings 在场 → 选举席已声明
    const sections = () => boot.ctx.slots.entries('settings:section').map((e) => e.meta?.section);
    const leaves = () => deriveSectionLeaves(boot.ctx.slots.entries('settings:section'));
    const fiber = await boot.ctx.plugin(rosterClientPlugin);
    expect(sections()).toContain('agents');
    expect(leaves()).toContainEqual({ id: 'agents', label: 'Agent 设置' });
    expect(boot.ctx.slots.entries('settings:section').find((e) => e.meta?.section === 'agents')?.order).toBe(10);
    await fiber.dispose();
    expect(sections()).not.toContain('agents');
    expect(leaves().map((l) => l.id)).not.toContain('agents');
  });
});
