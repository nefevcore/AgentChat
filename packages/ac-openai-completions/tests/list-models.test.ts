import { describe, it, expect } from 'vitest';
import { OpenAICompletions } from '../src/index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('OpenAICompletions.listModels', () => {
  it('GET {baseUrl}/models + Bearer 鉴权，返回字典序 id 清单', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new OpenAICompletions({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1/',
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        return jsonResponse({ object: 'list', data: [{ id: 'm-b' }, { id: 'm-a' }, { object: 'model' }] });
      }) as unknown as typeof fetch,
    });
    const models = await client.listModels();
    expect(captured.url).toBe('https://api.example.com/v1/models');
    expect(captured.init.headers.authorization).toBe('Bearer sk-test');
    expect(models).toEqual(['m-a', 'm-b']); // 字典序；无 id 条目剔除
  });

  it('params.api_key 单次覆盖构造 key', async () => {
    const captured: { init?: any } = {};
    const client = new OpenAICompletions({
      apiKey: 'sk-ctor',
      fetchImpl: (async (_url: any, init: any) => {
        captured.init = init;
        return jsonResponse({ data: [] });
      }) as unknown as typeof fetch,
    });
    await client.listModels({ api_key: 'sk-percall' });
    expect(captured.init.headers.authorization).toBe('Bearer sk-percall');
  });

  it('HTTP 非 2xx → 抛错含状态码与响应体（与 stream 同款文案）', async () => {
    const client = new OpenAICompletions({
      fetchImpl: (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.listModels()).rejects.toThrow(/LLM HTTP 401/);
  });

  it('响应缺 data 数组 → 抛错（非 OpenAI 兼容端点可诊断）', async () => {
    const client = new OpenAICompletions({
      fetchImpl: (async () => jsonResponse({ object: 'list' })) as unknown as typeof fetch,
    });
    await expect(client.listModels()).rejects.toThrow(/\/models 响应缺少 data 数组/);
  });

  it('close 后拒绝调用', async () => {
    const client = new OpenAICompletions({
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    client.close();
    await expect(client.listModels()).rejects.toThrow(/已 close/);
  });
});
