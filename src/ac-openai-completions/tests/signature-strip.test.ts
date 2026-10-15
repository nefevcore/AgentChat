import { describe, it, expect } from 'vitest';
import { normalizeAssistantMessage } from '../src/index';

describe('cr-443 · tool_calls[].signature 剥离（跨 provider 重放不泄漏）', () => {
  it('completions 面：signature 不进 wire 消息', () => {
    const m = normalizeAssistantMessage(
      { role: 'assistant', content: '正文', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' }, signature: 'sig-x' }] },
      'strip',
    );
    expect(m.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]);
  });

  it('无 signature 的 tool_calls 原样透传', () => {
    const m = normalizeAssistantMessage(
      { role: 'assistant', content: '正文', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      'strip',
    );
    expect(m.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]);
  });
});
