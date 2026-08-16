// ============================================================
// src/core/context 单元测试 —— 单次执行输入快照与 inbox 双队列
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  createContext, pushSteer, drainSteer,
  enqueue, followup, steer, inject, drainInbox,
} from '../src/context';
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
  it('inbox 缺省为 next-turn / next-step 双空队列', () => {
    const ctx = base();
    expect(ctx.inbox).toEqual({ nextTurn: [], nextStep: [] });
    expect(ctx.systemPrompt).toBe('你是助手');
  });

  it('保留传入字段（含显式 inbox）', () => {
    const inbox = { nextTurn: [], nextStep: [{ role: 'user' as const, content: 'hi' }] };
    const ctx = createContext({
      llm: mockLLM, systemPrompt: 's', history: [], tools: new Map(),
      inbox, maxSteps: 3, deepThink: true,
    });
    expect(ctx.inbox).toBe(inbox);
    expect(ctx.maxSteps).toBe(3);
    expect(ctx.deepThink).toBe(true);
  });
});

describe('inbox 双队列原语', () => {
  it('enqueue：next-turn 与 next-step 分队列', () => {
    const ctx = base();
    enqueue(ctx, { role: 'user', content: 'A' }, 'next-turn');
    enqueue(ctx, { role: 'user', content: '一' }, 'next-step');
    expect(ctx.inbox.nextTurn.map(m => m.content)).toEqual(['A']);
    expect(ctx.inbox.nextStep.map(m => m.content)).toEqual(['一']);
  });

  it('followup → next-turn；steer/inject → next-step', () => {
    const ctx = base();
    followup(ctx, { role: 'user', content: 'A' });
    steer(ctx, { role: 'user', content: '一' });
    inject(ctx, { role: 'user', content: '二' });
    expect(ctx.inbox.nextTurn.map(m => m.content)).toEqual(['A']);
    expect(ctx.inbox.nextStep.map(m => m.content)).toEqual(['一', '二']);
  });

  it('drainInbox 消费指定队列并清空（FIFO）', () => {
    const ctx = base();
    steer(ctx, { role: 'user', content: '指令一' });
    steer(ctx, { role: 'user', content: '指令二' });
    followup(ctx, { role: 'user', content: 'A' });
    expect(drainInbox(ctx, 'next-step').map(m => m.content)).toEqual(['指令一', '指令二']);
    expect(drainInbox(ctx, 'next-turn').map(m => m.content)).toEqual(['A']);
    expect(ctx.inbox).toEqual({ nextTurn: [], nextStep: [] });
  });

  it('多次 drain 幂等（第二次返回空）', () => {
    const ctx = base();
    steer(ctx, { role: 'user', content: 'x' });
    expect(drainInbox(ctx, 'next-step')).toHaveLength(1);
    expect(drainInbox(ctx, 'next-step')).toHaveLength(0);
  });
});

describe('pushSteer / drainSteer（旧 API = next-step 兼容）', () => {
  it('push 追加 next-step、drain 清空并返回全部（先进先出）', () => {
    const ctx = base();
    pushSteer(ctx, { role: 'user', content: '指令一' });
    pushSteer(ctx, { role: 'user', content: '指令二' });
    const drained = drainSteer(ctx);
    expect(drained.map(m => m.content)).toEqual(['指令一', '指令二']);
    expect(ctx.inbox.nextStep).toHaveLength(0);
  });

  it('多次 drain 幂等（第二次返回空）', () => {
    const ctx = base();
    pushSteer(ctx, { role: 'user', content: 'x' });
    expect(drainSteer(ctx)).toHaveLength(1);
    expect(drainSteer(ctx)).toHaveLength(0);
  });
});
