// ============================================================
// src/agents/registry 单元测试 —— Agent 注册表（仅存配置，无实例）
// ============================================================
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../src/agents/registry';
import type { AgentConfig } from '../src/agents/config';

const agentA: AgentConfig = { agent_id: 'agentA', name: 'Agent A', llm: { provider: 'deepseek' } };
const agentB: AgentConfig = { agent_id: 'agentB', name: 'Agent B' };
const user: AgentConfig = { agent_id: 'user', name: '用户', virtual: true };

describe('AgentRegistry', () => {
  it('register / get / has / size', () => {
    const r = new AgentRegistry();
    r.register(agentA);
    r.register(agentB);
    expect(r.get('agentA')).toBe(agentA);
    expect(r.has('agentA')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.size).toBe(2);
  });

  it('只存配置，不实例化（§7.3 无状态化）', () => {
    const r = new AgentRegistry();
    r.register(agentA);
    const stored = r.get('agentA');
    expect(stored).toBe(agentA);
    expect(stored!.agent_id).toBe('agentA');
  });

  it('覆盖注册同 ID', () => {
    const r = new AgentRegistry();
    r.register({ agent_id: 'a', name: 'v1' });
    r.register({ agent_id: 'a', name: 'v2' });
    expect(r.get('a')?.name).toBe('v2');
    expect(r.size).toBe(1);
  });

  it('unregister', () => {
    const r = new AgentRegistry();
    r.register(agentA);
    r.unregister('agentA');
    expect(r.has('agentA')).toBe(false);
    expect(r.size).toBe(0);
  });

  it('isVirtual：仅 virtual:true 为虚拟', () => {
    const r = new AgentRegistry();
    r.register(agentA);
    r.register(user);
    expect(r.isVirtual('agentA')).toBe(false);
    expect(r.isVirtual('user')).toBe(true);
  });

  it('getAgentName：缺省回退为 ID', () => {
    const r = new AgentRegistry();
    r.register(agentA);
    expect(r.getAgentName('agentA')).toBe('Agent A');
    expect(r.getAgentName('unknown')).toBe('unknown');
  });

  it('listIds / list', () => {
    const r = new AgentRegistry();
    r.register(agentA);
    r.register(user);
    expect(r.listIds().sort()).toEqual(['agentA', 'user'].sort());
    expect(r.list().length).toBe(2);
  });
});
