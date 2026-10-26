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

  it('cr-442 · 同轮并行 functionResponse 合并进单个 user content（官方角色交替形态）', () => {
    const out = toGeminiContents([
      { role: 'user', content: '查两个文件' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', function: { name: 'read', arguments: '{}' } },
        { id: 'c2', function: { name: 'grep', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: '{"n":1}' },
      { role: 'tool', tool_call_id: 'c2', name: 'grep', content: '{"hits":2}' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: '查两个文件' }] },
      { role: 'model', parts: [
        { functionCall: { name: 'read', args: {} } },
        { functionCall: { name: 'grep', args: {} } },
      ] },
      { role: 'user', parts: [ // 两轮 tool 消息合并为一 content
        { functionResponse: { name: 'read', response: { n: 1 } } },
        { functionResponse: { name: 'grep', response: { hits: 2 } } },
      ] },
      { role: 'model', parts: [{ text: 'done' }] },
    ]);
  });

  it('cr-442 · 中性 tool_calls[].signature → functionCall.thoughtSignature 回传', () => {
    const out = toGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' }, signature: 'sig-abc' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: '{}' },
    ]);
    expect(out.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read', args: {}, thoughtSignature: 'sig-abc' } }] });
  });

  it('cr-442 · 尾部 tool 消息（语义化中断后不再有 assistant）也合并收口', () => {
    const out = toGeminiContents([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'ask', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'ask', content: '{"interrupt":true}' },
    ]);
    expect(out.contents.at(-1)).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'ask', response: { interrupt: true } } }] });
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

  it('cr-442 · functionCall part 携带 thoughtSignature → toolCalls[].signature 透传', () => {
    const m = createGeminiChunkMapper();
    expect(m({ candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: {}, thoughtSignature: 'sig-xyz' } }] } }] }))
      .toMatchObject({ toolCalls: [{ index: 0, signature: 'sig-xyz' }] });
  });

  it('cr-442 · promptFeedback.blockReason（请求级安全拦截）→ finish 原值透传，不再静默空成功', () => {
    const m = createGeminiChunkMapper();
    expect(m({ candidates: [{ finishReason: 'SAFETY' }] })).toEqual({ delta: '', finish: 'SAFETY' });
    expect(m({ promptFeedback: { blockReason: 'SAFETY' } })).toEqual({ delta: '', finish: 'SAFETY' });
    expect(m({ promptFeedback: { blockReason: 'BLOCKLIST' }, usageMetadata: { promptTokenCount: 5 } })).toEqual({ delta: '', finish: 'BLOCKLIST' });
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

describe('GeminiCompletions.chat（cr-442 聚合）', () => {
  it('functionCall thoughtSignature 聚合进 toolCalls[].signature；usage 直取末片', async () => {
    const client = new GeminiCompletions({
      fetchImpl: (async () => sseResponse([
        { candidates: [{ content: { parts: [{ text: '查一下' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { a: 1 }, thoughtSignature: 'sig-1' } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 } },
      ])) as unknown as typeof fetch,
    });
    const res = await client.chat({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] });
    expect(res).toMatchObject({
      model: 'gemini-2.5-pro',
      text: '查一下',
      toolCalls: [{ id: 'call_0', name: 'read', arguments: '{"a":1}', signature: 'sig-1' }],
      finish: 'stop',
      usage: { prompt: 10, completion: 4, total: 14 },
    });
  });

  it('promptFeedback.blockReason 聚合为 finish（端到端）', async () => {
    const client = new GeminiCompletions({
      fetchImpl: (async () => sseResponse([
        { promptFeedback: { blockReason: 'SAFETY' } },
      ])) as unknown as typeof fetch,
    });
    const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.finish).toBe('SAFETY');
    expect(res.text).toBe('');
  });
});
