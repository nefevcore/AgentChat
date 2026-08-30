import { describe, it, expect } from 'vitest';
import { OpenAIChatLLM } from '../src/openai';

/**
 * provider 纯净性回归：来源标签由各域插件的 stepStart 钩子
 * （@agentchat/contracts 的 makeSourceTagStepStartHook 工厂构造，
 * ownerless automatic）在 LLM 请求之前完成——provider 无关，任何
 * 协议适配器（OpenAI/GLM/DeepSeek/未来 Anthropic）零重复实现。
 * toProviderMessages 只做角色解析与序列化，不得改写消息内容——
 * 带 source 的事件消息原样透传。
 */

function makeLLM(): OpenAIChatLLM {
  return new OpenAIChatLLM({ apiKey: 'test-key', baseURL: 'http://localhost:1', model: 'test-model' });
}

describe('toProviderMessages —— 内容透传（不打标）', () => {
  const llm = makeLLM();

  it('带 source 的事件消息原样输出（无标签前缀）', () => {
    const out = llm.toProviderMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '到点检查新闻', source: { kind: 'timer', form: 'hint' } },
    ]);
    expect(out[1]).toMatchObject({ role: 'user', content: '到点检查新闻' });
  });

  it('已由钩子打标的消息（正文含标签行）原样透传，不二次处理', () => {
    const out = llm.toProviderMessages([
      { role: 'user', content: '[定时触发]\n到点检查新闻', source: { kind: 'timer', form: 'hint' } },
    ]);
    expect(out[0].content).toBe('[定时触发]\n到点检查新闻');
  });

  it('agent 视角转换（agent→user）只换角色不改内容', () => {
    const out = llm.toProviderMessages([
      { role: 'agent', content: '帮我查一下', agent_id: 'agent-bob' },
    ], 'agent-alice');
    expect(out[0]).toMatchObject({ role: 'user', content: '帮我查一下' });
  });
});
