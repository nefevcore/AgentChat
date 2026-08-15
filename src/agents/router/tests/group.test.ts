// ============================================================
// src/agents/group 单元测试 —— 群组管理（纯内存：状态 + 分发）
// ============================================================
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '@agentchat/agents';
import { GroupManager } from '../src/group';
import type { AgentConfig } from '@agentchat/agent-config';

function makeCtx() {
  const registry = new AgentRegistry();
  registry.register({ agent_id: 'agentA', name: 'Agent A' });
  registry.register({ agent_id: 'agentB', name: 'Agent B' });
  registry.register({ agent_id: 'user', name: '用户', virtual: true } satisfies AgentConfig);
  return { registry };
}

describe('GroupManager 生命周期', () => {
  it('createGroup：校验参与者已注册；emit group.created', () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    const created: any[] = [];
    gm.on('group.created', (g) => created.push(g));
    const group = gm.createGroup({ group_id: 'g1', name: '研发群', participants: ['agentA', 'agentB'] });
    expect(group.participants).toEqual(['agentA', 'agentB']);
    expect(created.length).toBe(1);
    expect(gm.getGroup('g1')).toBe(group);
  });

  it('createGroup：重复 ID 抛错；未注册参与者抛错', () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    gm.createGroup({ group_id: 'g1', name: 'G', participants: ['agentA'] });
    expect(() => gm.createGroup({ group_id: 'g1', name: 'G2', participants: ['agentA'] })).toThrow('已存在');
    expect(() => gm.createGroup({ group_id: 'g2', name: 'G', participants: ['ghost'] })).toThrow('未在注册表中找到');
  });

  it('join / leave / rename / delete + 事件', () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    const events: string[] = [];
    for (const e of ['group.join', 'group.leave', 'group.renamed', 'group.deleted'] as const) {
      gm.on(e, () => events.push(e));
    }
    gm.createGroup({ group_id: 'g1', name: 'G', participants: ['agentA'] });

    expect(gm.joinGroup('g1', 'agentB')).toBe(true);
    expect(gm.isParticipant('g1', 'agentB')).toBe(true);
    expect(gm.joinGroup('g1', 'agentB')).toBe(true); // 幂等

    expect(gm.renameGroup('g1', '新名')).toBe(true);
    expect(gm.getGroup('g1')?.name).toBe('新名');

    expect(gm.leaveGroup('g1', 'agentB')).toBe(true);
    expect(gm.isParticipant('g1', 'agentB')).toBe(false);

    expect(gm.deleteGroup('g1')).toBe(true);
    expect(gm.deleteGroup('g1')).toBe(false); // 已删
    expect(gm.getGroup('g1')).toBeUndefined();
    expect(events).toEqual(['group.join', 'group.renamed', 'group.leave', 'group.deleted']);
  });

  it('leaveGroup 清空参与者：自动删除群组', () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    gm.createGroup({ group_id: 'g1', name: 'G', participants: ['agentA'] });
    gm.leaveGroup('g1', 'agentA');
    expect(gm.getGroup('g1')).toBeUndefined();
  });

  it('查询：listGroups / listGroupsForAgent', () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    gm.createGroup({ group_id: 'g1', name: 'G1', participants: ['agentA', 'agentB'] });
    gm.createGroup({ group_id: 'g2', name: 'G2', participants: ['agentA'] });
    expect(gm.listGroups().length).toBe(2);
    expect(gm.listGroupsForAgent('agentB').map(g => g.group_id)).toEqual(['g1']);
  });
});

describe('GroupManager 消息分发', () => {
  it('deliverGroupMessage：emit group.message.received + 对每个其他参与者 emit group.trigger', async () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    gm.createGroup({ group_id: 'g1', name: 'G', participants: ['agentA', 'agentB'] });

    const messages: any[] = [];
    const triggers: any[] = [];
    gm.on('group.message.received', (m) => messages.push(m));
    gm.on('group.trigger', (t) => triggers.push(t));

    const result = await gm.deliverGroupMessage({
      from: 'user', to: '*', type: 'chat.send', payload: '大家好', group_id: 'g1',
    });

    expect(result.status).toBe('triggered');
    expect(result.triggered.sort()).toEqual(['agentA', 'agentB']);
    expect(messages.length).toBe(1);
    expect(messages[0].payload).toBe('大家好');
    // 触发目标 = 除发送者外的所有参与者
    expect(triggers.map(t => t.to).sort()).toEqual(['agentA', 'agentB']);
    expect(triggers[0].group_id).toBe('g1');
  });

  it('发送者不在群组（非 user）：抛错', async () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    gm.createGroup({ group_id: 'g1', name: 'G', participants: ['agentA'] });
    await expect(gm.deliverGroupMessage({
      from: 'agentB', to: '*', type: 'chat.send', payload: 'x', group_id: 'g1',
    })).rejects.toThrow('不在群组');
  });

  it('房间不存在：抛错', async () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    await expect(gm.deliverGroupMessage({
      from: 'user', to: '*', type: 'chat.send', payload: 'x', group_id: 'nope',
    })).rejects.toThrow('不存在');
  });

  it('发送者是参与者：不触发自己', async () => {
    const { registry } = makeCtx();
    const gm = new GroupManager(registry);
    gm.createGroup({ group_id: 'g1', name: 'G', participants: ['agentA', 'agentB'] });
    const triggers: any[] = [];
    gm.on('group.trigger', (t) => triggers.push(t));
    await gm.deliverGroupMessage({
      from: 'agentA', to: '*', type: 'chat.send', payload: 'hi', group_id: 'g1',
    });
    expect(triggers.map(t => t.to)).toEqual(['agentB']);
  });
});
