// ============================================================
// interaction-recovery 测试 —— 崩溃后悬空 tool_call 对账
// ============================================================

import { describe, it, expect } from 'vitest';
import { MemoryDurableInteractionStore } from '@agentchat/durable-interaction';
import type { LLMRequestMessage } from '@agentchat/types';
import { recoverInteractionHistory } from '../src/interaction-recovery';

function assistantWithCalls(calls: Array<{ id: string; name: string }>): LLMRequestMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: '{}' } })),
  } as LLMRequestMessage;
}

describe('recoverInteractionHistory', () => {
  it('answered ask_questions → 合成 tool 结果，恢复可续跑', () => {
    const store = new MemoryDurableInteractionStore();
    const record = store.open({ key: 'k', kind: 'ask_questions', correlationId: 'call_1', payload: { question: 'Q?', options: ['A'] } });
    store.reply(record.id, 'A');

    // loadHistory 从持久化文件读回的是 role='agent'（视角转换前）
    const persistedAssistant = { ...assistantWithCalls([{ id: 'call_1', name: 'ask_questions' }]), role: 'agent' as const };
    const history: LLMRequestMessage[] = [
      { role: 'user', content: 'hi' },
      persistedAssistant,
    ];
    const recovered = recoverInteractionHistory(store, history);
    expect(recovered).toHaveLength(3);
    const tool = recovered[2];
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(JSON.parse(tool.content as string).data.answers).toEqual(['A']);
  });

  it('pending ask_questions → 不合成本块，保持悬空等待回答', () => {
    const store = new MemoryDurableInteractionStore();
    store.open({ key: 'k', kind: 'ask_questions', correlationId: 'call_1', payload: { question: 'Q?' } });

    const history: LLMRequestMessage[] = [
      assistantWithCalls([{ id: 'call_1', name: 'ask_questions' }]),
    ];
    const recovered = recoverInteractionHistory(store, history);
    expect(recovered).toEqual(history); // 未合成，仍悬空（由 WS park 阻止新 run）
  });

  it('已有 tool 结果时幂等跳过；非 ask 悬空调用补 unknown outcome', () => {
    const store = new MemoryDurableInteractionStore();
    const history: LLMRequestMessage[] = [
      assistantWithCalls([
        { id: 'call_ask', name: 'ask_questions' },
        { id: 'call_bash', name: 'bash' },
      ]),
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_ask', name: 'ask_questions' },
    ];
    const recovered = recoverInteractionHistory(store, history);
    expect(recovered).toHaveLength(3);
    const tool = recovered.find(m => m.role === 'tool' && m.tool_call_id === 'call_bash')!;
    expect(tool).toBeDefined();
    expect(tool.content).toContain('unknown outcome');
  });

  it('同一次 ask_questions 多题（同 correlationId 多记录）全部 answered 才恢复', () => {
    const store = new MemoryDurableInteractionStore();
    store.open({ key: 'k', kind: 'ask_questions', correlationId: 'call_1', payload: { question: 'Q1' }, id: 'i1' });
    store.open({ key: 'k', kind: 'ask_questions', correlationId: 'call_1', payload: { question: 'Q2' }, id: 'i2' });
    store.reply('i1', 'A1');

    const history: LLMRequestMessage[] = [assistantWithCalls([{ id: 'call_1', name: 'ask_questions' }])];
    expect(recoverInteractionHistory(store, history)).toEqual(history);

    store.reply('i2', 'A2');
    const recovered = recoverInteractionHistory(store, history);
    expect(recovered).toHaveLength(2);
    expect(JSON.parse(recovered[1].content as string).data.answers).toEqual(['A1', 'A2']);
  });
});
