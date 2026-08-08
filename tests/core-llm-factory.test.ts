// ============================================================
// src/core/llm 工厂与请求体构建单元测试
//
// 以 deepseek-v4-flash 参考配置驱动：
//   {
//     "provider": "deepseek",
//     "base_url": "https://api.deepseek.com",
//     "model": "deepseek-v4-flash",
//     "reasoning_effort": "high",
//     "thinking": true,
//     "logprobs": false,
//     "tool_choice": "auto",
//     "default": true
//   }
// ============================================================

import { describe, it, expect } from 'vitest';
import { createLLM, resolveApiKey } from '../src/core/llm';
import { DeepSeekChatLLM } from '../src/core/llm/deepseek';
import { OpenAIChatLLM } from '../src/core/llm/openai';
import type { LLMConfig, LLMRequest } from '../src/core/types';

const DEEPSEEK_V4_FLASH: LLMConfig = {
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  reasoning_effort: 'high',
  thinking: true,
  logprobs: false,
  tool_choice: 'auto',
};

function buildBody(llm: any, req: LLMRequest, stream = true): any {
  return (llm as any).buildRequestBody(req, stream);
}

describe('createLLM 工厂（LLMConfig → 适配器映射）', () => {
  it('deepseek provider → DeepSeekChatLLM 实例', () => {
    const llm = createLLM({ ...DEEPSEEK_V4_FLASH, api_key: 'sk-test' });
    expect(llm).toBeInstanceOf(DeepSeekChatLLM);
  });

  it('openai provider → OpenAIChatLLM 实例', () => {
    const llm = createLLM({ provider: 'openai', api_key: 'sk-test', model: 'gpt-4o' });
    expect(llm).toBeInstanceOf(OpenAIChatLLM);
    expect(llm).not.toBeInstanceOf(DeepSeekChatLLM);
  });

  it('snake_case 配置字段正确映射（base_url→baseURL, max_tokens→maxTokens 等）', () => {
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

  it('模型缺省：DeepSeek 默认 deepseek-v4-flash', () => {
    const llm = createLLM({ provider: 'deepseek', api_key: 'sk-test' }) as DeepSeekChatLLM;
    expect((llm as any).model).toBe('deepseek-v4-flash');
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

describe('DeepSeekChatLLM.buildRequestBody', () => {
  const mkLLM = () => createLLM({ ...DEEPSEEK_V4_FLASH, api_key: 'sk-test' }) as DeepSeekChatLLM;
  const req: LLMRequest = {
    messages: [{ role: 'user', content: '你好' }],
    userId: 'user__agent_a',
  };

  it('思考模式开启：thinking.enabled + reasoning_effort=high', () => {
    const body = buildBody(mkLLM(), req);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('thinking=false → thinking.disabled（不传 reasoning_effort）', () => {
    const body = buildBody(mkLLM(), { ...req, thinking: false });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('userId 透传为 user_id（缓存隔离）', () => {
    const body = buildBody(mkLLM(), req);
    expect(body.user_id).toBe('user__agent_a');
  });

  it('tool_choice=auto（默认）不传输；required 传输', () => {
    const auto = buildBody(mkLLM(), req);
    expect(auto.tool_choice).toBeUndefined();

    const required = buildBody(createLLM({ ...DEEPSEEK_V4_FLASH, api_key: 'sk-test', tool_choice: 'required' }), req);
    expect(required.tool_choice).toBe('required');
  });

  it('logprobs=true / top_logprobs>0 传输', () => {
    const body = buildBody(createLLM({
      ...DEEPSEEK_V4_FLASH, api_key: 'sk-test', logprobs: true, top_logprobs: 5,
    }), req);
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(5);
  });

  it('模型与流式标记正确', () => {
    const body = buildBody(mkLLM(), req, true);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('OpenAIChatLLM.buildRequestBody', () => {
  const llm = createLLM({ provider: 'openai', api_key: 'sk-test', model: 'gpt-4o' }) as OpenAIChatLLM;
  const req: LLMRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: { name: 'echo', description: '回声', parameters: { type: 'object', properties: {} } },
    }],
  };

  it('tools 映射为 OpenAI 格式', () => {
    const body = buildBody(llm, req);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'echo', description: '回声', parameters: { type: 'object', properties: {} } } }]);
  });

  it('温度等参数合并：请求级 > 实例默认', () => {
    const body = buildBody(llm, { ...req, temperature: 0.5, maxTokens: 100 });
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    // 未传时使用实例默认（未设置则不出现）
    const body2 = buildBody(llm, req);
    expect(body2.temperature).toBeUndefined();
  });

  it('postProcessBodyJson 默认原样返回', () => {
    const raw = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'C:\\xampp' }] });
    expect((llm as any).postProcessBodyJson(raw)).toBe(raw);
  });
});

describe('DeepSeekChatLLM.postProcessBodyJson（\\x 规避回归）', () => {
  const llm = createLLM({ ...DEEPSEEK_V4_FLASH, api_key: 'sk-test' }) as DeepSeekChatLLM;
  const cases = [
    { name: 'Windows 路径 C:\\xampp', content: 'C:\\xampp' },
    { name: '正则 \\x1b 转义', content: '正则 \\x1b 转义' },
    { name: '普通反斜杠+反斜杠x 混合', content: 'C:\\temp\\xfile' },
    { name: '纯中文无反斜杠', content: '纯中文内容' },
  ];

  for (const c of cases) {
    it(`${c.name} —— 语义等价且消除 \\x 误判源`, () => {
      const raw = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: c.content }] });
      const safe = (llm as any).postProcessBodyJson(raw);
      expect(JSON.parse(safe).messages[0].content).toBe(JSON.parse(raw).messages[0].content);
      expect(() => JSON.parse(safe)).not.toThrow();
      expect(safe).not.toMatch(/\\\\x/);
    });
  }
});
