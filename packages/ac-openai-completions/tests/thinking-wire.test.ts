import { describe, expect, it } from 'vitest';
import { thinkingWireForm, normalizeAssistantMessage } from '../src/index';

/**
 * 思考字段 wire 单源（cr-294 KV 边界修复）：live 与回放统一产中立 reasoning
 * 键，序列化边界按端点家族翻译——两侧字节同形是前缀缓存不断裂的前提。
 */
describe('thinkingWireForm（端点家族判定）', () => {
  it('DeepSeek 官方端点 → reasoning_content', () => {
    expect(thinkingWireForm('https://api.deepseek.com/v1', 'deepseek-chat')).toBe('reasoning_content');
    expect(thinkingWireForm('https://api.deepseek.com', undefined)).toBe('reasoning_content');
  });

  it('GLM 官方端点 → thinking', () => {
    expect(thinkingWireForm('https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash')).toBe('thinking');
    expect(thinkingWireForm('https://open.zhipuai.cn/api/paas/v4', undefined)).toBe('thinking');
  });

  it('模型名 glm 前缀（非官方域网关）→ thinking', () => {
    expect(thinkingWireForm('https://gw.example.com/v1', 'glm-4.6')).toBe('thinking');
    expect(thinkingWireForm('https://gw.example.com/v1', 'chatglm3-turbo')).toBe('thinking');
  });

  it('模型名 deepseek 前缀（第三方网关）→ reasoning_content', () => {
    expect(thinkingWireForm('https://gw.example.com/v1', 'deepseek-reasoner')).toBe('reasoning_content');
  });

  it('其余端点 → strip', () => {
    expect(thinkingWireForm('https://api.openai.com/v1', 'gpt-5')).toBe('strip');
    expect(thinkingWireForm(undefined, undefined)).toBe('strip');
  });
});

describe('normalizeAssistantMessage（中立键 → wire 形态）', () => {
  it('reasoning_content 形态：中立 reasoning → reasoning_content，剥其余思考键', () => {
    expect(normalizeAssistantMessage(
      { role: 'assistant', content: '', reasoning: '思考A', thinkingSignature: 'sig' },
      'reasoning_content',
    )).toEqual({ role: 'assistant', content: '', reasoning_content: '思考A' });
  });

  it('thinking 形态：中立 reasoning → thinking，剥其余思考键', () => {
    expect(normalizeAssistantMessage(
      { role: 'assistant', content: '', reasoning: '思考A', thinkingSignature: 'sig' },
      'thinking',
    )).toEqual({ role: 'assistant', content: '', thinking: '思考A' });
  });

  it('strip 形态：全部思考键剥掉（死字段不出 body）', () => {
    expect(normalizeAssistantMessage(
      { role: 'assistant', content: '正文', reasoning: '思考A', thinking: '残留', thinkingSignature: 'sig' },
      'strip',
    )).toEqual({ role: 'assistant', content: '正文' });
  });

  it('非 assistant 消息原样（含 tool_calls 的 user/tool 不动）', () => {
    const m = { role: 'user', content: 'hi', reasoning: 'x' };
    expect(normalizeAssistantMessage(m, 'strip')).toBe(m);
  });

  it('无 reasoning 的 assistant：strip 不补键；reasoning_content 形态恒写空串（DeepSeek thinking+tools 强制回传防线）', () => {
    expect(normalizeAssistantMessage({ role: 'assistant', content: '正文' }, 'strip'))
      .toEqual({ role: 'assistant', content: '正文' });
    expect(normalizeAssistantMessage({ role: 'assistant', content: '正文' }, 'reasoning_content'))
      .toEqual({ role: 'assistant', content: '正文', reasoning_content: '' });
  });
});
