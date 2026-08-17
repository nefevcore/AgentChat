import { describe, it, expect } from 'vitest';
import { GLMChatLLM, GLM_DEFAULT_BASE_URL, GLM_DEFAULT_MODEL } from '../src/glm';
import { glmAdapter } from '../src/adapters';
import { OpenAIChatLLM } from '@agentchat/llm-openai';

/**
 * GLMChatLLM.buildRequestBody 协议收敛测试：
 *   · glm-5.3 强制思考（req.thinking=false 仍 enabled）
 *   · glm-5.2 尊重 thinking 开关（disabled）
 *   · reasoning_effort 仅思考开启时传递
 *   · stream_options 移除（GLM usage 由最后 chunk 携带）
 *   · tool_choice 非 auto 移除（GLM 仅支持 auto）
 *   · stop 字符串包装为数组、超 4 截断
 *   · temperature/top_p 收敛到 GLM 取值域
 *   · user_id 6-128 字符内传递、超界不传
 */

const REQ_BASE = { messages: [{ role: 'user', content: '你好' }] };

function buildBody(llm: GLMChatLLM, req: any = REQ_BASE, stream = true): any {
  return (llm as any).buildRequestBody(req, stream);
}

describe('GLMChatLLM 默认值', () => {
  it('模型缺省 → glm-5.3，baseURL 缺省 → 智谱开放平台端点', () => {
    const llm = new GLMChatLLM({ apiKey: 'test-glm-key' });
    expect(llm.model).toBe(GLM_DEFAULT_MODEL);
    expect((llm as any).baseURL).toBe(GLM_DEFAULT_BASE_URL);
    expect((llm as any).baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('继承 OpenAIChatLLM', () => {
    const llm = new GLMChatLLM({ apiKey: 'k' });
    expect(llm).toBeInstanceOf(OpenAIChatLLM);
  });
});

describe('GLM thinking / reasoning_effort', () => {
  it('glm-5.3 强制思考：thinking.enabled + reasoning_effort 默认 max', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', model: 'glm-5.3' });
    const body = buildBody(llm);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('max');
  });

  it('glm-5.3 强制思考：请求 thinking=false 仍 enabled（disabled 会报错）', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', model: 'glm-5.3' });
    const body = buildBody(llm, { ...REQ_BASE, thinking: false });
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('max');
  });

  it('glm-4.7 同为强制思考系列', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', model: 'glm-4.7' });
    expect(buildBody(llm, { ...REQ_BASE, thinking: false }).thinking).toEqual({ type: 'enabled' });
  });

  it('glm-5.2 非强制：thinking=false → disabled 且不传 reasoning_effort', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', model: 'glm-5.2' });
    const body = buildBody(llm, { ...REQ_BASE, thinking: false });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('glm-5.2 非强制：默认（不传 thinking）→ enabled', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', model: 'glm-5.2' });
    expect(buildBody(llm).thinking).toEqual({ type: 'enabled' });
  });

  it('reasoning_effort 支持 low/high/max 三档', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      const llm = new GLMChatLLM({ apiKey: 'k', model: 'glm-5.3', reasoningEffort: effort });
      expect(buildBody(llm).reasoning_effort).toBe(effort);
    }
  });
});

describe('GLM 协议差异收敛', () => {
  it('stream_options 移除（GLM usage 由最后一个 chunk 自动携带）', () => {
    const llm = new GLMChatLLM({ apiKey: 'k' });
    expect(buildBody(llm, REQ_BASE, true).stream_options).toBeUndefined();
  });

  it('tool_choice 不透传（GLM 仅支持 auto，非 auto 值在适配器层丢弃）', () => {
    const llm = glmAdapter({ provider: 'glm', api_key: 'k', tool_choice: 'required' }) as GLMChatLLM;
    const body = buildBody(llm);
    expect(body.tool_choice).toBeUndefined();
  });

  it('stop 字符串包装为数组', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', stop: 'END' });
    expect(buildBody(llm).stop).toEqual(['END']);
  });

  it('stop 数组超 4 截断为 4 个', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', stop: ['a', 'b', 'c', 'd', 'e'] });
    expect(buildBody(llm).stop).toEqual(['a', 'b', 'c', 'd']);
  });

  it('temperature 收敛到 [0,1]、top_p 收敛到 [0.01,1]', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', temperature: 1.7, topP: 0.005 });
    const body = buildBody(llm);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.01);
  });

  it('temperature 为 0 时保持 0（不误伤下界）', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', temperature: 0 });
    expect(buildBody(llm).temperature).toBe(0);
  });

  it('user_id 长度合规（6-128）时传递', () => {
    const llm = new GLMChatLLM({ apiKey: 'k' });
    const body = buildBody(llm, { ...REQ_BASE, userId: 'user__agent_a' });
    expect(body.user_id).toBe('user__agent_a');
  });

  it('user_id 过短（<6 字符）不传', () => {
    const llm = new GLMChatLLM({ apiKey: 'k' });
    const body = buildBody(llm, { ...REQ_BASE, userId: 'abc' });
    expect(body.user_id).toBeUndefined();
  });
});

describe('GLM 通用字段透传', () => {
  it('tools/response_format/max_tokens 等继承基类行为', () => {
    const llm = new GLMChatLLM({ apiKey: 'k', maxTokens: 4096, responseFormat: 'json_object' });
    const body = buildBody(llm, {
      ...REQ_BASE,
      tools: [{ type: 'function', function: { name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } } }],
    });
    expect(body.model).toBe('glm-5.3');
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: {} } } }]);
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
  });
});
