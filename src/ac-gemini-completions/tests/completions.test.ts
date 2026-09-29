import { describe, it, expect } from 'vitest';
import { GeminiCompletions, toGeminiContents, toGeminiTools, toGeminiGenerationConfig, mapGeminiUsage, mapGeminiFinishReason, createGeminiChunkMapper } from '../src/index';

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseResponse(events: unknown[], status = 200): Response {
  const body = textStream(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  return new Response(body, { status });
}

describe('toGeminiContents', () => {
  it('system → systemInstruction；assistant → model；tool_calls → functionCall；tool → functionResponse', () => {
    const out = toGeminiContents([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'let me check', tool_calls: [{ function: { name: 'read', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'x', name: 'read', content: '{"ok":true}' },
    ]);
    expect(out.systemInstruction).toBe('sys');
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'let me check' }, { functionCall: { name: 'read', args: { a: 1 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { ok: true } } }] },
    ]);
  });
});

describe('toGeminiTools / toGeminiGenerationConfig', () => {
  it('function 嵌套 → functionDeclarations；采样参数 → generationConfig', () => {
    const tools = toGeminiTools([{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]);
    expect(tools).toEqual([{ functionDeclarations: [{ name: 'read', parameters: { type: 'object' } }] }]);
    const cfg = toGeminiGenerationConfig({ temperature: 0.5, top_p: 0.9, max_tokens: 100, stop: 'END' });
    expect(cfg).toEqual({ temperature: 0.5, topP: 0.9, maxOutputTokens: 100, stopSequences: ['END'] });
  });
});

describe('mapGeminiFinishReason / mapGeminiUsage', () => {
  it('STOP → stop；usageMetadata 归一（thoughts 并入 completion）', () => {
    expect(mapGeminiFinishReason('STOP')).toBe('stop');
    expect(mapGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 })).toEqual({
      prompt: 10, completion: 8, total: 18,
    });
  });
});

describe('createGeminiChunkMapper', () => {
  it('text/thought/functionCall/finishReason/usageMetadata 映射；空载荷返回 null', () => {
    const m = createGeminiChunkMapper();
    expect(m({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })).toEqual({ delta: 'hi' });
    expect(m({ candidates: [{ content: { parts: [{ text: 'th', thought: true }] } }] })).toEqual({ delta: '', reasoning: 'th' });
    expect(m({ candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { a: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2 } })).toEqual({
      delta: '', toolCalls: [{ index: 0, id: 'call_0', name: 'read', argumentsDelta: '{"a":1}' }], finish: 'stop', usage: { prompt: 2, completion: 0 },
    });
    expect(m({ candidates: [{}] })).toBeNull();
  });
});

describe('GeminiCompletions.stream（SSE 全链路）', () => {
  it('模型名进 URL 路径 + x-goog-api-key 头 + systemInstruction + generationConfig', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new GeminiCompletions({
      apiKey: 'g-key',
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        return sseResponse([
          { candidates: [{ content: { parts: [{ text: '你' }] } }] },
          { candidates: [{ content: { parts: [{ text: '好' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
        ]);
      }) as unknown as typeof fetch,
    });
    const chunks: unknown[] = [];
    for await (const c of client.stream({ model: 'gemini-flash', temperature: 0.7, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(captured.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:streamGenerateContent?alt=sse');
    expect(captured.init.headers['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(captured.init.body);
    expect(body.systemInstruction).toBe('s');
    expect(body.generationConfig).toEqual({ temperature: 0.7 });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(chunks.at(-1)).toMatchObject({ finish: 'stop', usage: { prompt: 3, completion: 2 } });
  });

  it('传输层键剥离不进 body；模型名 URL 编码', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new GeminiCompletions({
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        return sseResponse([]);
      }) as unknown as typeof fetch,
    });
    for await (const _c of client.stream({ model: 'm/x 1', messages: [], api_key: 'k', provider: 'px' }));
    expect(String(captured.url)).toContain('/models/m%2Fx%201:');
    const body = JSON.parse(captured.init.body);
    expect('provider' in body).toBe(false);
    expect('api_key' in body).toBe(false);
  });

  it('HTTP 错误透传', async () => {
    const client = new GeminiCompletions({
      fetchImpl: (async () => new Response('{"error":"bad"}', { status: 400 })) as unknown as typeof fetch,
    });
    await expect(client.stream({ model: 'm', messages: [] }).next()).rejects.toThrow(/LLM HTTP 400/);
  });
});

describe('GeminiCompletions.listModels', () => {
  it('GET /v1beta/models 过滤 generateContent 能力 + 剥 models/ 前缀', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new GeminiCompletions({
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        return new Response(JSON.stringify({ models: [
          { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        ] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const models = await client.listModels({ api_key: 'k' });
    expect(captured.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(captured.init.headers['x-goog-api-key']).toBe('k');
    expect(models).toEqual(['gemini-a', 'gemini-b']);
  });
});
