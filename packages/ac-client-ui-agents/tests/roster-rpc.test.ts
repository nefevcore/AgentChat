// ============================================================
// roster-rpc.test.ts —— 名册 session/roster 投影（cr-1185）
//
// fetchAgents（agents 域）：session/roster pair 行 → lastActivity/
// lastMessage（发言口径）；agent⇄agent 对桶不入名册（现语义）。
// fetchGroups（group 域）：群行（成员流折叠）→ lastActivity。
// ============================================================
import { describe, it, expect } from 'vitest';
import { fetchAgents } from '../client/index.ts';
import { fetchGroups } from 'ac-client-ui-group/client/index.ts';

type Rpc = Parameters<typeof fetchAgents>[0];

/** RPC 桩：按 method 路由到预置载荷（session/roster 失败降级 = 抛错分支） */
function rpcOf(routes: Record<string, unknown>, opts: { failRoster?: boolean } = {}): Rpc {
  return {
    call: async <T>(method: string): Promise<T> => {
      if (method === 'session/roster' && opts.failRoster === true) throw new Error('不可用');
      const hit = routes[method];
      if (hit === undefined) throw new Error('意外 RPC：' + method);
      return hit as T;
    },
  } as Rpc;
}

describe('cr-1185 · fetchAgents ← session/roster', () => {
  it('pair 行 → lastActivity/lastMessage（发言口径 + viewer 归一）；agent⇄agent 不入册；非 pair kind 忽略', async () => {
    const { agents } = await fetchAgents(rpcOf({
      'agents/list': { agents: [{ id: 'alpha', description: '甲' }, { id: 'beta', description: '乙' }] },
      'conversation/stats': { running: [] },
      'session/roster': {
        rows: [
          { key: 'alpha~user', kind: 'pair', lastSpeechAt: '2026-11-10T01:00:05.000Z', lastAgent: 'alpha', lastRole: 'agent', lastText: '在的', lastAt: '2026-11-10T01:00:06.000Z', speech: 2, total: 3 },
          { key: 'user~beta', kind: 'pair', lastSpeechAt: '2026-11-10T02:00:00.000Z', lastAgent: 'user', lastRole: 'agent', lastText: '收到', lastAt: '2026-11-10T02:00:01.000Z', speech: 2, total: 2 },
          // agent⇄agent 对桶：现语义不入名册（矩阵视角承载）——但键不含
          // viewer 时 toAgentList 自然不映射，此处行本身仍会被传换面过滤
          { key: 'alpha~beta', kind: 'pair', lastSpeechAt: '2026-11-10T03:00:00.000Z', lastAgent: 'beta', lastRole: 'agent', lastText: '对桶', lastAt: null, speech: 1, total: 1 },
          { key: '3f2b8c1a-9d4e-4f7a-b2c6-1e8a5d0f9b31', kind: 'single', lastSpeechAt: '2026-11-10T04:00:00.000Z', lastAgent: 'alpha', lastRole: 'agent', lastText: '独立', lastAt: null, speech: 1, total: 1 },
        ],
        warm: 'warm',
      },
    }));
    const alpha = agents.find((a) => a.id === 'alpha')!;
    expect(alpha.lastActivity).toBe(Date.parse('2026-11-10T01:00:05.000Z'));
    expect(alpha.lastMessage).toMatchObject({ role: 'agent', agent_id: 'alpha', content: '在的', timestamp: '2026-11-10T01:00:05.000Z' });
    const beta = agents.find((a) => a.id === 'beta')!;
    // viewer 归一：lastAgent 'user' → role 'user'、agent_id 'user'
    expect(beta.lastMessage).toMatchObject({ role: 'user', agent_id: 'user', content: '收到' });
  });

  it('session/roster 失败 → 静默降级（无活动面，名册仍可建）', async () => {
    const { agents } = await fetchAgents(rpcOf({
      'agents/list': { agents: [{ id: 'alpha', description: '甲' }] },
      'conversation/stats': { running: [] },
    }, { failRoster: true }));
    expect(agents).toHaveLength(1);
    expect(agents[0]!.lastActivity).toBeUndefined();
    expect(agents[0]!.lastMessage).toBeUndefined();
  });
});

describe('cr-1185 · fetchGroups ← session/roster', () => {
  it('group 行（成员流折叠）→ lastActivity；缺席 = 无字段；失败降级', async () => {
    const routes: Record<string, unknown> = {
      'group/list': { groups: [{ id: 'g-g1x', name: '群一', members: ['alpha', 'beta'] }, { id: 'g-g2x', name: '群二', members: ['alpha'] }] },
      'session/roster': {
        rows: [
          { key: 'g-g1x', kind: 'group', lastSpeechAt: '2026-11-10T05:00:00.000Z', lastAgent: 'beta', lastRole: 'agent', lastText: 'B', lastAt: '2026-11-10T05:00:01.000Z', speech: 4, total: 6 },
        ],
      },
    };
    const { groups } = await fetchGroups(rpcOf(routes) as never);
    const g1 = groups.find((g) => g.group_id === 'g-g1x')!;
    expect(g1.lastActivity).toBe(Date.parse('2026-11-10T05:00:00.000Z'));
    // 无 roster 行的群：无 lastActivity 字段（旧形态兼容）
    const g2 = groups.find((g) => g.group_id === 'g-g2x')!;
    expect(g2.lastActivity).toBeUndefined();
    // 失败降级
    const { groups: degraded } = await fetchGroups(rpcOf({ 'group/list': routes['group/list'] }, { failRoster: true }) as never);
    expect(degraded).toHaveLength(2);
    expect(degraded[0]!.lastActivity).toBeUndefined();
  });
});
