import { describe, it, expect } from 'vitest';
import { OpenAICompletions, mapChunk, sseDataEvents } from '../src/index';

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseResponse(events: string[], status = 200): Response {
  const body = textStream(events.map((e) => `data: ${e}\n\n`).join(''));
  return new Response(body, { status });
}

function jsonFetch(captured: { url?: unknown; init?: any }, respond: () => Response): typeof fetch {
  return (async (url: any, init: any) => {
    captured.url = url;
    captured.init = init;
    return respond();
  }) as unknown as typeof fetch;
}

describe('sseDataEvents', () => {
  it('切分事件、忽略非 data 行、兼容 \\r\\n 与结尾残包', async () => {
    const raw = 'event: x\ndata: {"a":1}\n\r\ndata: {"b":2}\n\n: ping\ndata: tail';
    const out: string[] = [];
    for await (const data of sseDataEvents(textStream(raw))) out.push(data);
    expect(out).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });
});

describe('mapChunk', () => {
  it('content / reasoning_content / finish / usage 映射，空片返回 null', () => {
    expect(mapChunk({ choices: [{ delta: { content: '嗨' }, finish_reason: null }] })).toEqual({ delta: '嗨' });
    expect(mapChunk({ choices: [{ delta: { reasoning_content: '思考' } }] })).toEqual({ delta: '', reasoning: '思考' });
    expect(
      mapChunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    ).toEqual({ delta: '', finish: 'stop', usage: { prompt: 3, completion: 4, total: 7 } });
    expect(mapChunk({ choices: [{ delta: {} }] })).toBeNull();
    expect(mapChunk({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toEqual({
      delta: '',
      usage: { prompt: 1, completion: 1 },
    });
  });
});

describe('OpenAICompletions', () => {
  it('stream：请求形态（URL 归一/鉴权/stream 标志）与 [DONE] 终止', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new OpenAICompletions({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1/',
      fetchImpl: jsonFetch(captured, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
          JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          '[DONE]',
        ]),
      ),
    });
    const chunks: Array<{ delta: string; finish?: string }> = [];
    for await (const chunk of client.stream({ model: 'x-1', messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }
    expect(captured.url).toBe('https://api.example.com/v1/chat/completions');
    expect(captured.init.headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(captured.init.body)).toMatchObject({
      model: 'x-1',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(chunks.map((c) => c.delta).join('')).toBe('你好');
    expect(chunks.at(-1)?.finish).toBe('stop');
  });

  it('chat：聚合 delta/reasoning/usage，defaultModel 兜底', async () => {
    const client = new OpenAICompletions({
      defaultModel: 'm-1',
      fetchImpl: jsonFetch({}, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] }),
          JSON.stringify({ choices: [{ delta: { content: '答案' } }] }),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          }),
          '[DONE]',
        ]),
      ),
    });
    const result = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(result).toMatchObject({
      model: 'm-1',
      text: '答案',
      reasoning: '想一想',
      finish: 'stop',
      usage: { prompt: 1, completion: 2 },
    });
  });

  it('HTTP 非 2xx → 抛错含状态码与响应体', async () => {
    const client = new OpenAICompletions({
      fetchImpl: jsonFetch({}, () => new Response('{"error":"bad key"}', { status: 401 })),
    });
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(
      /LLM HTTP 401/,
    );
  });

  it('close 后拒绝后续调用', async () => {
    const client = new OpenAICompletions({
      fetchImpl: jsonFetch({}, () => sseResponse(['[DONE]'])),
    });
    client.close();
    await expect(client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/已 close/);
  });

  it('params.api_key 单次覆盖构造 key，且绝不进请求体（传输层键剥离）', async () => {
    // ① 覆盖：authorization 用 params.api_key 而非构造 apiKey
    const captured: { url?: unknown; init?: any } = {};
    const client = new OpenAICompletions({
      apiKey: 'sk-ctor',
      fetchImpl: jsonFetch(captured, () => sseResponse(['[DONE]'])),
    });
    await client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], api_key: 'sk-percall' });
    expect(captured.init.headers.authorization).toBe('Bearer sk-percall');
    expect(JSON.parse(captured.init.body)).not.toHaveProperty('api_key');

    // ② 无覆盖：回落构造 key
    await client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(captured.init.headers.authorization).toBe('Bearer sk-ctor');

    // ③ 两者皆无：无 authorization 头
    const bare = new OpenAICompletions({ fetchImpl: jsonFetch(captured, () => sseResponse(['[DONE]'])) });
    await bare.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(captured.init.headers.authorization).toBeUndefined();
  });
});
