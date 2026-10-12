// ============================================================
// ac-router/tests/readers.test.ts —— agentOf 读取器单测（M25 §3.2）
// 读取器读错载荷形状 → undefined → 门控静默放行（最阴的失败形态）——
// 单测锁定正确形状的读取路径；载荷变形由类型锚定在定义处拦截。
// （cr-349：此前零测试——对齐 ac-llm/ac-agent-loop/ac-tools readers.test.ts 先例）
// ============================================================
import { describe, it, expect } from 'vitest';
import { agentOfMessage, agentOfDeliver } from '../src/readers.ts';

describe('router 域 agentOf 读取器（M25 §3.2）', () => {
  it('agentOfMessage：router/message-received · reply-completed 首参直读', () => {
    expect(agentOfMessage('a1')).toBe('a1');
    expect(agentOfMessage('watchdog')).toBe('watchdog');
  });

  it('agentOfDeliver：router/before-deliver 载体 agentId 字段直读', () => {
    expect(agentOfDeliver({ agentId: 'helper', message: { role: 'user', content: 'hi' }, sender: 'user', source: 'user', conversationId: 'user~helper' })).toBe('helper');
  });
});
