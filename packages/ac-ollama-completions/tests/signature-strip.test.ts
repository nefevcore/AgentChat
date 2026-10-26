import { describe, it, expect } from 'vitest';
import { toOllamaMessages } from '../src/index';

describe('cr-443 · tool_calls[].signature 剥离（跨 provider 重放不泄漏）', () => {
  it('signature 不进 wire 消息', () => {
    const out = toOllamaMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' }, signature: 'sig-x' }] },
    ]);
    expect(out[0].tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]);
  });

  it('无 signature 原样透传', () => {
    const out = toOllamaMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    ]);
    expect(out[0].tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]);
  });
});
