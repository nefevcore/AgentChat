// ============================================================
// ac-llm/tests/readers.test.ts —— agentOf 读取器单测（M25 §3.2）
// 读取器读错载荷形状 → undefined → 门控静默放行（最阴的失败形态）——
// 单测锁定正确形状的读取路径；载荷变形由类型锚定在定义处拦截。
// （cr-348：此前零测试——对齐 ac-agent-loop/ac-tools readers.test.ts 先例）
// ============================================================
import { describe, it, expect } from 'vitest';
import { agentOfChatCall, agentOfChatInput } from '../src/readers.ts';

describe('llm 域 agentOf 读取器（M25 §3.2）', () => {
  it('agentOfChatCall：llm/before-chat 载体 → input.meta.agent 通道', () => {
    expect(agentOfChatCall({ input: { model: 'm', messages: [], meta: { agent: 'a1' } } })).toBe('a1');
    expect(agentOfChatCall({ input: { model: 'm', messages: [] } })).toBeUndefined();
  });

  it('agentOfChatInput：llm/chat-error · llm/delta-* 首参 → meta.agent 通道', () => {
    expect(agentOfChatInput({ model: 'm', messages: [], meta: { agent: 'a2' } })).toBe('a2');
    expect(agentOfChatInput({ model: 'm', messages: [] })).toBeUndefined();
  });
});
