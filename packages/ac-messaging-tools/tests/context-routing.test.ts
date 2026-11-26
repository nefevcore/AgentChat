// ============================================================
// context-routing.test.ts —— send_agent(user) 语境路由 + send_group
// group_id 缺省化判定（cr-1339 语境路由完成体）
//
// 路由判据（call.conversationId 键形）：
//   uuid 形 → single 桶直投；viewer 对桶 → user 对桶；群语境（g- 形或
// gid~self 且群登记在册）→ fail-loud 引导 send_group；agent~agent 委托
// 桶 → fail-loud 拒绝（用户裁决：中途向用户冒话语义未定义）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as collab from '../src/index.ts';

type Tool = { execute: (args: Record<string, unknown>, call: Record<string, unknown>) => Promise<unknown> };

/** ctx 桩工厂：捕获工具注册面；group 面/投递捕获可配置 */
function bootCtx(opts: { groups?: Record<string, string>; member?: boolean } = {}) {
  const registered = new Map<string, Tool>();
  const deliveries: Array<Record<string, unknown>> = [];
  const groupSends: Array<{ gid: string; message: string }> = [];
  const ctx = {
    tools: { register: (t: never) => { const tool = t as unknown as { name: string } & Tool; registered.set(tool.name, tool); } },
    agents: { has: () => true, get: (id: string) => (id === 'user' ? { virtual: true, id } : { id }), settingsOf: () => undefined, list: () => [] },
    conversation: { deliver: async (_to: string, _m: string, options: Record<string, unknown>) => { deliveries.push(options); return { kind: 'sent' }; } },
    get: (name: string) => name === 'group' ? {
      get: (gid: string) => (opts.groups !== undefined && opts.groups[gid] !== undefined ? { id: gid, name: opts.groups[gid] } : undefined),
      isMember: () => opts.member !== false,
      send: async (gid: string, _from: string, message: string) => { groupSends.push({ gid, message }); return { triggered: [] }; },
    } : undefined,
    agentLoop: { registerPromptSection: () => {} },
  };
  collab.apply(ctx as never);
  return { registered, deliveries, groupSends };
}

const call = (agentId: string, conversationId: string | undefined) => ({ agentId, conversationId });

const GID = 'g-test01';
const SID = '018f1e23-4567-7890-abcd-ef0123456789';

describe('send_agent(user) 语境路由（cr-1339）', () => {
  it('uuid 形（single 会话）→ 直投当前 single 桶（conversationId = 原键）', async () => {
    const { registered, deliveries } = bootCtx();
    const r = await registered.get('send_agent')!.execute({ to: 'user', message: '进度通报' }, call('alpha', SID));
    expect(r).toMatchObject({ ok: true });
    expect(deliveries[0]!.conversationId).toBe(SID);
  });

  it('viewer 对桶（alpha~user）→ user 对桶（pairKey 归一）', async () => {
    const { registered, deliveries } = bootCtx();
    await registered.get('send_agent')!.execute({ to: 'user', message: 'hi' }, call('alpha', 'alpha~user'));
    expect(deliveries[0]!.conversationId).toBe('alpha~user');
  });

  it('无会话键（直连 run）→ user 对桶（M19 缺省语义）', async () => {
    const { registered, deliveries } = bootCtx();
    await registered.get('send_agent')!.execute({ to: 'user', message: 'hi' }, call('alpha', undefined));
    expect(deliveries[0]!.conversationId).toBe('alpha~user');
  });

  it('群成员流键（gid~self，群在册）→ fail-loud 引导 send_group', async () => {
    const { registered } = bootCtx({ groups: { [GID]: '测试群' } });
    const r = await registered.get('send_agent')!.execute({ to: 'user', message: 'hi' }, call('alpha', GID + '~alpha'));
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { error?: string }).error)).toContain('send_group');
  });

  it('群本体键（g- 形）→ fail-loud 引导 send_group', async () => {
    const { registered } = bootCtx({ groups: { [GID]: '测试群' } });
    const r = await registered.get('send_agent')!.execute({ to: 'user', message: 'hi' }, call('alpha', GID));
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { error?: string }).error)).toContain('send_group');
  });

  it('agent~agent 委托桶 → fail-loud 拒绝（中途向用户冒话语义未定义）', async () => {
    const { registered } = bootCtx();
    const r = await registered.get('send_agent')!.execute({ to: 'user', message: 'hi' }, call('alpha', 'alpha~beta'));
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { error?: string }).error)).toContain('委托');
  });

  it('群服务缺席的 gid~self 同形键 → 落委托判定（键面不可辨，群登记消歧）', async () => {
    const { registered } = bootCtx({});
    const r = await registered.get('send_agent')!.execute({ to: 'user', message: 'hi' }, call('alpha', GID + '~alpha'));
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { error?: string }).error)).toContain('委托');
  });
});

describe('send_group group_id 缺省化（cr-1339）', () => {
  it('群会话内缺省 group_id → 发到当前群（成员流键 gid~self）', async () => {
    const { registered, groupSends } = bootCtx({ groups: { [GID]: '测试群' } });
    const r = await registered.get('send_group')!.execute({ message: '大家好' }, call('alpha', GID + '~alpha'));
    expect(r).toMatchObject({ ok: true });
    expect(groupSends[0]!.gid).toBe(GID);
  });

  it('群本体键（g- 形）缺省 → 当前群', async () => {
    const { registered, groupSends } = bootCtx({ groups: { [GID]: '测试群' } });
    const r = await registered.get('send_group')!.execute({ message: '大家好' }, call('alpha', GID));
    expect(r).toMatchObject({ ok: true });
    expect(groupSends[0]!.gid).toBe(GID);
  });

  it('非群语境缺省 group_id → 报错引导（先 list_groups）', async () => {
    const { registered } = bootCtx({ groups: { [GID]: '测试群' } });
    const r = await registered.get('send_group')!.execute({ message: '大家好' }, call('alpha', 'alpha~user'));
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { error?: string }).error)).toContain('list_groups');
  });

  it('显式 group_id 照旧（不受缺省化影响）', async () => {
    const { registered, groupSends } = bootCtx({ groups: { [GID]: 'x', g_other9: 'y' } });
    const r = await registered.get('send_group')!.execute({ group_id: 'g_other9', message: '大家好' }, call('alpha', 'alpha~user'));
    expect(r).toMatchObject({ ok: true });
    expect(groupSends[0]!.gid).toBe('g_other9');
  });
});
