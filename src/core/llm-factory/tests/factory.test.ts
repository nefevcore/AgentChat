import { describe, it, expect } from 'vitest';
import { createLLM } from '../src/index';
import { DeepSeekChatLLM } from '@agentchat/llm-deepseek';
import { GLMChatLLM } from '@agentchat/llm-glm';
import { OpenAIChatLLM } from '@agentchat/llm-openai';
import { resolveApiKey } from '@agentchat/llm';
import type { LLMConfig } from '@agentchat/llm';

describe('createLLM 工厂（LLMConfig → 适配器映射）', () => {
  it('deepseek provider → DeepSeekChatLLM 实例', () => {
    const llm = createLLM({ provider: 'deepseek', api_key: 'sk-test' });
    expect(llm).toBeInstanceOf(DeepSeekChatLLM);
  });

  it('glm provider → GLMChatLLM 实例', () => {
    const llm = createLLM({ provider: 'glm', api_key: 'sk-test' });
    expect(llm).toBeInstanceOf(GLMChatLLM);
    expect(llm).toBeInstanceOf(OpenAIChatLLM);
  });

  it('openai provider → OpenAIChatLLM 实例', () => {
    const llm = createLLM({ provider: 'openai', api_key: 'sk-test', model: 'gpt-4o' });
    expect(llm).toBeInstanceOf(OpenAIChatLLM);
    expect(llm).not.toBeInstanceOf(DeepSeekChatLLM);
    expect(llm).not.toBeInstanceOf(GLMChatLLM);
  });

  it('模型缺省：DeepSeek 默认 deepseek-v4-flash', () => {
    const llm = createLLM({ provider: 'deepseek', api_key: 'sk-test' }) as DeepSeekChatLLM;
    expect((llm as any).model).toBe('deepseek-v4-flash');
  });

  it('模型缺省：GLM 默认 glm-5.3 + 智谱端点', () => {
    const llm = createLLM({ provider: 'glm', api_key: 'sk-test' }) as GLMChatLLM;
    expect((llm as any).model).toBe('glm-5.3');
    expect((llm as any).baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
  });
});

describe('resolveApiKey（${ENV_VAR} 解析）', () => {
  it('字面 key 原样返回', () => {
    expect(resolveApiKey('sk-abc')).toBe('sk-abc');
  });

  it('${ENV_VAR} 从环境变量解析', () => {
    process.env.TEST_DEEPSEEK_KEY = 'sk-env-value';
    expect(resolveApiKey('${TEST_DEEPSEEK_KEY}')).toBe('sk-env-value');
    delete process.env.TEST_DEEPSEEK_KEY;
  });

  it('未定义返回空串', () => {
    expect(resolveApiKey(undefined)).toBe('');
  });
});

const DEEPSEEK_V4_FLASH: LLMConfig = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  reasoning_effort: 'high',
  thinking: true,
  logprobs: false,
  tool_choice: 'auto',
};

describe('createLLM 映射与请求体冒烟', () => {
  it('snake_case 配置字段正确映射（base_url→baseURL 等）', () => {
    const llm = createLLM({
      provider: 'deepseek', api_key: 'sk-test',
      base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash',
      temperature: 0.3, max_tokens: 1024, top_p: 0.9,
      response_format: 'json_object', stop: ['END'],
      reasoning_effort: 'max', thinking: false, logprobs: true,
      top_logprobs: 5, tool_choice: 'required',
    }) as DeepSeekChatLLM;
    expect((llm as any).baseURL).toBe('https://api.deepseek.com');
    expect((llm as any).maxTokens).toBe(1024);
    expect((llm as any).topP).toBe(0.9);
  });

  it('deepseek body：thinking.enabled + reasoning_effort + user_id + tool_choice', () => {
    const llm = createLLM({ ...DEEPSEEK_V4_FLASH, api_key: 'sk-test' }) as DeepSeekChatLLM;
    const body = (llm as any).buildRequestBody({
      messages: [{ role: 'user', content: '你好' }],
      userId: 'user__agent_a',
    }, true);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.user_id).toBe('user__agent_a');
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

const GLM_53: LLMConfig = {
  provider: 'glm',
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-5.3',
  reasoning_effort: 'low',
  thinking: true,
};

describe('createLLM glm 映射与请求体冒烟', () => {
  it('glm body：glm-5.3 强制思考 enabled + reasoning_effort + 无 stream_options', () => {
    const llm = createLLM({ ...GLM_53, api_key: 'sk-test' }) as GLMChatLLM;
    const body = (llm as any).buildRequestBody({
      messages: [{ role: 'user', content: '你好' }],
      userId: 'user__agent_a',
      thinking: false, // glm-5.3 忽略关闭请求
    }, true);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
    expect(body.user_id).toBe('user__agent_a');
    expect(body.stream_options).toBeUndefined();
  });

  it('reasoning_effort low 在 deepseek 侧降级为 high（DeepSeek 仅 high/max）', () => {
    const llm = createLLM({ provider: 'deepseek', api_key: 'sk-test', reasoning_effort: 'low' }) as DeepSeekChatLLM;
    const body = (llm as any).buildRequestBody({ messages: [{ role: 'user', content: 'hi' }] }, true);
    expect(body.reasoning_effort).toBe('high');
  });
});
