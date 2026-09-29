import { describe, it, expect } from 'vitest';
import { OllamaCompletions, toOllamaMessages, toOllamaOptions, mapOllamaUsage, createOllamaChunkMapper, ndjsonLines } from '../src/index';

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function ndjsonResponse(lines: unknown[], status = 200): Response {
  return new Response(textStream(lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10))), { status });
}

describe('ndjsonLines', () => {
  it('按行切分、跳过空行、兼容结尾残包', async () => {
    const NL = String.fromCharCode(10);
    const out: string[] = [];
    for await (const line of ndjsonLines(textStream('{"a":1}' + NL + NL + '{"b":2}' + String.fromCharCode(13) + NL + '{"c":3}'))) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('toOllamaMessages / toOllamaOptions', () => {
  it('attachments 传输键剥离；采样参数 → options 嵌套', () => {
    const out = toOllamaMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi', attachments: [{ kind: 'image', ref: 'f.png' }] },
    ]);
    expect(out).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
    expect(toOllamaOptions({ temperature: 0.5, max_tokens: 64, stop: 'END' })).toEqual({ temperature: 0.5, num_predict: 64, stop: ['END'] });
    expect(toOllamaOptions({})).toBeUndefined();
  });
});

describe('mapOllamaUsage', () => {
  it('prompt_eval_count/eval_count 归一；0/0 无效', () => {
    expect(mapOllamaUsage({ prompt_eval_count: 10, eval_count: 5 })).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(mapOllamaUsage({ prompt_eval_count: 0, eval_count: 0 })).toBeUndefined();
  });
});

describe('createOllamaChunkMapper', () => {
  it('content/thinking/tool_calls/done 终行 finish+usage', () => {
    const m = createOllamaChunkMapper();
    expect(m({ message: { role: 'assistant', content: 'hi' } })).toEqual({ delta: 'hi' });
    expect(m({ message: { role: 'assistant', content: '', thinking: 'th' } })).toEqual({ delta: '', reasoning: 'th' });
    const toolChunk = m({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: { a: 1 } } }] }, done: true, prompt_eval_count: 3, eval_count: 4 });
    expect(toolChunk).toEqual({
      delta: '', toolCalls: [{ index: 0, id: 'call_0', name: 'read', argumentsDelta: '{"a":1}' }], finish: 'tool_calls', usage: { prompt: 3, completion: 4, total: 7 },
    });
    expect(m({ message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 1, eval_count: 2 })).toEqual({
      delta: 'ok', finish: 'stop', usage: { prompt: 1, completion: 2, total: 3 },
    });
    expect(m({ done: false })).toBeNull();
  });
});

describe('OllamaCompletions.stream（NDJSON 全链路）', () => {
  it('POST /api/chat + NDJSON 流式 + options 嵌套 + 无 key 不发鉴权头', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const NL = String.fromCharCode(10);
    const client = new OllamaCompletions({
      baseUrl: 'http://localhost:11434',
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        const raw = [
          { message: { role: 'assistant', content: '你' } },
          { message: { role: 'assistant', content: '好' } },
          { done: true, prompt_eval_count: 6, eval_count: 2 },
        ].map((l) => JSON.stringify(l)).join(NL);
        return new Response(textStream(raw), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const chunks: unknown[] = [];
    for await (const c of client.stream({ model: 'llama4', temperature: 0.3, messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(captured.url).toBe('http://localhost:11434/api/chat');
    expect(captured.init.headers.authorization).toBeUndefined();
    const body = JSON.parse(captured.init.body);
    expect(body).toMatchObject({ model: 'llama4', stream: true, options: { temperature: 0.3 } });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(chunks.at(-1)).toMatchObject({ finish: 'stop', usage: { prompt: 6, completion: 2 } });
  });

  it('api_key 单次覆盖 → Bearer；provider/headers 剥离', async () => {
    const captured: { init?: any } = {};
    const NL = String.fromCharCode(10);
    const client = new OllamaCompletions({
      fetchImpl: (async (_url: any, init: any) => {
        captured.init = init;
        return new Response(textStream(JSON.stringify({ done: true, prompt_eval_count: 0, eval_count: 0 })), { status: 200 });
      }) as unknown as typeof fetch,
    });
    void NL;
    for await (const _c of client.stream({ model: 'm', messages: [], api_key: 'k', provider: 'px', headers: { 'x-s': '1' } }));
    expect(captured.init.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(captured.init.body);
    expect('provider' in body).toBe(false);
  });

  it('HTTP 错误透传', async () => {
    const client = new OllamaCompletions({
      fetchImpl: (async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch,
    });
    await expect(client.stream({ model: 'm', messages: [] }).next()).rejects.toThrow(/LLM HTTP 404/);
  });
});

describe('OllamaCompletions.listModels', () => {
  it('GET /api/tags 返回 name 字典序', async () => {
    const captured: { url?: unknown } = {};
    const client = new OllamaCompletions({
      fetchImpl: (async (url: any) => {
        captured.url = url;
        return new Response(JSON.stringify({ models: [{ name: 'llama4:latest' }, { name: 'qwen4:7b' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const models = await client.listModels();
    expect(captured.url).toBe('http://localhost:11434/api/tags');
    expect(models).toEqual(['llama4:latest', 'qwen4:7b']);
  });
});