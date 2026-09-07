// @vitest-environment jsdom
// ============================================================
// webui/tests/clients-roster.test.ts —— S2 roster 域插件验收
//
// §0.3 层 2 身份面（ctx.roster）+ 双模门面（runtime 在场绑单一事实源；
// 无 runtime 独立 Core——既有测试族兼容）+ 可摘除性。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createClient } from 'ac-client-runtime';
import { rosterDomainPlugin, RosterCore } from '../src/clients/roster';
import { bootWebuiRuntime } from './lib/webuiBoot';
import { useAgentStore } from '../src/stores/agents';
import { resetClientRuntime } from '../src/runtime/clientRuntime';

describe('S2 · roster 域插件（层 2 身份面 + agents 域写面）', () => {
  it('服务装载：ctx.roster 可解析；名册排序 + 显示名解析（列表 → 预设 → id 兜底）', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(rosterDomainPlugin);
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

  it('门面（runtime 在场）：useAgentStore 绑 ctx.roster.core——单一事实源', async () => {
    const app = await bootWebuiRuntime(); // 设 runtime 单例
    const fiber = await app.ctx.plugin(rosterDomainPlugin); // roster 域件挂册
    setActivePinia(createPinia());
    const store = useAgentStore();
    store.setAgents([{ id: 'z9', name: '共享', lastActivity: 1 } as never]);
    expect(app.ctx.roster.agents.value.map((a) => a.id)).toEqual(['z9']); // 同一 Core
    await fiber.dispose();
  });

  it('门面（无 runtime）：独立 Core——既有测试族语义不变', async () => {
    resetClientRuntime();
    setActivePinia(createPinia());
    const s1 = useAgentStore();
    s1.setAgents([{ id: 'q1', name: '隔离', lastActivity: 1 } as never]);
    expect(s1.getAgentName('q1')).toBe('隔离');
    // 新 pinia 实例 → 新 Core（测试间不串扰）
    setActivePinia(createPinia());
    const s2 = useAgentStore();
    expect(s2.agents).toEqual([]);
  });

  it('可摘除性（D19/S2）：fiber dispose → ctx.roster 消失；门面回落独立 Core', async () => {
    const ctx = await createClient();
    const fiber = await ctx.plugin(rosterDomainPlugin);
    expect(ctx.roster).toBeDefined();
    await fiber.dispose();
    expect((ctx as { roster?: unknown }).roster).toBeUndefined();
    const core = new RosterCore();
    expect(core.agents.value).toEqual([]); // Core 独立可用（门面回落路径）
  });
});
