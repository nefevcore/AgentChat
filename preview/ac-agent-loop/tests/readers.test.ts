// ============================================================
// ac-agent-loop/tests/readers.test.ts —— agentOf 命名读取器单测（M25 §3.2）
// 读取器读错载荷形状 → undefined → 门控静默放行（最阴的失败形态）——
// 单测锁定正确形状的读取路径；载荷变形由类型锚定在定义处拦截。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  agentOfRunCall,
  agentOfRunRequest,
  agentOfStepCall,
  agentOfStepTransform,
  agentOfRunTransform,
} from '../src/readers.ts';
import type {
  LoopRunCall,
  LoopRunRequest,
  LoopRunTransform,
  LoopStepCall,
  LoopStepTransform,
} from '../src/contract.ts';

const request = { model: 'm', messages: [], agent: 'a1' } as unknown as LoopRunRequest;
const requestNoAgent = { model: 'm', messages: [] } as unknown as LoopRunRequest;

describe('loop 域 agentOf 读取器（M25 §3.2）', () => {
  it('agentOfRunCall：before-run 载体 → request.agent', () => {
    const call = { request } as LoopRunCall;
    expect(agentOfRunCall(call)).toBe('a1');
    expect(agentOfRunCall({ request: requestNoAgent })).toBeUndefined();
  });

  it('agentOfRunRequest：run-started/after-run 首参', () => {
    expect(agentOfRunRequest(request)).toBe('a1');
    expect(agentOfRunRequest(requestNoAgent)).toBeUndefined();
  });

  it('agentOfStepCall：before-step 载体 → agent（M25 §3.1 新通道）', () => {
    const call = { agent: 'a1', messages: [] } as LoopStepCall;
    expect(agentOfStepCall(call)).toBe('a1');
    expect(agentOfStepCall({ agent: undefined, messages: [] })).toBeUndefined();
  });

  it('agentOfStepTransform：transform-step 载体 → agent', () => {
    const payload = { agent: 'a1', step: {} as never } as LoopStepTransform;
    expect(agentOfStepTransform(payload)).toBe('a1');
  });

  it('agentOfRunTransform：transform-run 载体 → request.agent', () => {
    const payload = { request, result: {} as never } as unknown as LoopRunTransform;
    expect(agentOfRunTransform(payload)).toBe('a1');
  });
});
