// ============================================================
// src/agents/virtual-agent 单元测试 —— 虚拟 Agent（user 端点）
// ============================================================
import { describe, it, expect } from 'vitest';
import { VirtualAgent } from '../src/virtual-agent';
import type { AgentConfig } from '@agentchat/agent-config';

const userConfig: AgentConfig = { agent_id: 'user', name: '用户', virtual: true };

describe('VirtualAgent', () => {
  it('receive：纯确认回执，不虚构 assistant 回复', async () => {
    const va = new VirtualAgent(userConfig);
    const result = await va.receive({ from: 'agentA', to: 'user', type: 'chat.send', payload: '你好' });
    expect(result.content).toContain('已收到');
    expect(result.content).toContain('agentA');
    expect(result.interrupted).toBe(false);
  });

  it('trigger：虚拟 Agent 不支持自主推理', async () => {
    const va = new VirtualAgent(userConfig);
    const result = await va.trigger({ hint: 'tick' });
    expect(result.content).toContain('不支持自主推理');
  });

  it('agentId / name 来自配置', () => {
    const va = new VirtualAgent(userConfig);
    expect(va.agentId).toBe('user');
    expect(va.name).toBe('用户');
  });
});
