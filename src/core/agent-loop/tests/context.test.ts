// ============================================================
// src/core/context 单元测试 —— 单次执行输入快照
// ============================================================

import { describe, it, expect } from 'vitest';
import { createContext, pushSteer, drainSteer } from '../src/context';
import type { CurrentContext } from '../src/context';
import type { LLMProvider } from '@agentchat/llm';
import type { AgentMessage } from '@agentchat/types';

const mockLLM: LLMProvider = {
  model: 'mock-model',
  async chat() { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
  stream() {
    return Object.assign(async function* () {}, {
      async result() { return { content: 'ok', toolCalls: [], finishReason: 'stop' }; },
    }) as any;
  },
  toProviderMessages: (msgs) => msgs as any[],
  fromProviderMessages: (msgs) => msgs as any[],
};

function base(): CurrentContext {
  return createContext({ llm: mockLLM, systemPrompt: '你是助手', history: [], tools: new Map() });
}

describe('createContext', () => {
  it('steer 缺省为空队列', () => {
    const ctx = base();
    expect(ctx.steer).toEqual([]);
    expect(ctx.systemPrompt).toBe('你是助手');
  });

  it('保留传入字段（含显式 steer）', () => {
    const steer: AgentMessage[] = [{ role: 'user', content: 'hi' }];
    const ctx = createContext({
      llm: mockLLM, systemPrompt: 's', history: [], tools: new Map(),
      steer, maxTurns: 3, deepThink: true,
    });
    expect(ctx.steer).toBe(steer);
    expect(ctx.maxTurns).toBe(3);
    expect(ctx.deepThink).toBe(true);
  });
});

describe('pushSteer / drainSteer', () => {
  it('push 追加、drain 清空并返回全部（先进先出）', () => {
    const ctx = base();
    pushSteer(ctx, { role: 'user', content: '指令一' });
    pushSteer(ctx, { role: 'user', content: '指令二' });
    const drained = drainSteer(ctx);
    expect(drained.map(m => m.content)).toEqual(['指令一', '指令二']);
    expect(ctx.steer).toHaveLength(0);
  });

  it('多次 drain 幂等（第二次返回空）', () => {
    const ctx = base();
    pushSteer(ctx, { role: 'user', content: 'x' });
    expect(drainSteer(ctx)).toHaveLength(1);
    expect(drainSteer(ctx)).toHaveLength(0);
  });
});
