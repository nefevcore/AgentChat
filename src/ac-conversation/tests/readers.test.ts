// ============================================================
// ac-conversation/tests/readers.test.ts —— agentOf 读取器单测（M25 §3.2）
// 读取器读错载荷形状 → undefined → 门控静默放行（最阴的失败形态）——
// 单测锁定正确形状的读取路径；载荷变形由类型锚定在定义处拦截。
// （cr-350：此前零测试——对齐 ac-router/llm/agent-loop/tools readers.test.ts 先例）
// ============================================================
import { describe, it, expect } from 'vitest';
import { agentOfSteered } from '../src/readers.ts';

describe('conversation 域 agentOf 读取器（M25 §3.2）', () => {
  it('agentOfSteered：conversation/steered 首参直读', () => {
    expect(agentOfSteered('a1')).toBe('a1');
    expect(agentOfSteered('watchdog')).toBe('watchdog');
  });
});
