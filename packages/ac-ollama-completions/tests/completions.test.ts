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
describe('OllamaCompletions.chat（聚合语法糖）', () => {
  it('text/reasoning/toolCalls/finish/usage 聚合（tool_calls 整段 + 终行 usage）', async () => {
    const NL = String.fromCharCode(10);
    const client = new OllamaCompletions({
      fetchImpl: (async () =>
        new Response(
          textStream([
            { message: { role: 'assistant', content: '算', thinking: '想' } },
            { message: { role: 'assistant', content: '一下' } },
            // 真机形态：tool_calls 与 done 终行同行到达（整段、无增量）
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: { a: 1 } } }] }, done: true, prompt_eval_count: 4, eval_count: 6 },
          ].map((l) => JSON.stringify(l)).join(NL)),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const result = await client.chat({ model: 'llama4', messages: [] });
    expect(result).toEqual({
      model: 'llama4',
      text: '算一下',
      reasoning: '想',
      toolCalls: [{ id: 'call_0', name: 'add', arguments: '{"a":1}' }],
      finish: 'tool_calls',
      usage: { prompt: 4, completion: 6, total: 10 },
    });
  });
});

describe('无进展超时（idle 语义，对齐 openai 库测试形态）', () => {
  /** 永不落地的 fetch（abort 即以 reason 拒绝在途请求——对齐 undici） */
  function hangingFetch(): typeof fetch {
    return (async (_url: any, init: any) =>
      new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as unknown as typeof fetch;
  }

  it('建连挂起：窗口内无响应 → 中止并给出可诊断错误', async () => {
    const client = new OllamaCompletions({ timeoutMs: 60, fetchImpl: hangingFetch() });
    await expect(client.chat({ model: 'm', messages: [] })).rejects.toThrow(/LLM 响应超时/);
  });

  it('流静默：首行数据到达后长期无新行 → 窗口内中止（已收分片保留在异常前）', async () => {
    const NL = String.fromCharCode(10);
    const client = new OllamaCompletions({
      timeoutMs: 60,
      fetchImpl: (async (_url: any, init: any) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(JSON.stringify({ message: { role: 'assistant', content: '一' } }) + NL));
              // 首行后静默：不 close、不排程——模拟死流
              init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const c of client.stream({ model: 'm', messages: [] })) chunks.push(c.delta);
      })(),
    ).rejects.toThrow(/LLM 响应超时/);
    expect(chunks).toEqual(['一']); // 首行真实到达（计时器曾按行刷新）
  });
});

describe('close 语义', () => {
  it('close 后拒绝调用', async () => {
    const client = new OllamaCompletions({
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    client.close();
    await expect(client.listModels()).rejects.toThrow(/已 close/);
  });
});

describe('流协议防御', () => {
  it('NDJSON 行解析失败 → fail-loud 报错（带行预览）', async () => {
    const NL = String.fromCharCode(10);
    const client = new OllamaCompletions({
      fetchImpl: (async () => new Response(textStream('not-json' + NL), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(client.stream({ model: 'm', messages: [] }).next()).rejects.toThrow(/LLM NDJSON 数据解析失败/);
  });

  it('meta/attachments 传输键不进请求体（stripTransportKeys 白名单 + 消息级剥离）', async () => {
    const captured: { init?: any } = {};
    const NL = String.fromCharCode(10);
    const client = new OllamaCompletions({
      fetchImpl: (async (_url: any, init: any) => {
        captured.init = init;
        return new Response(textStream(JSON.stringify({ done: true, prompt_eval_count: 0, eval_count: 0 })), { status: 200 });
      }) as unknown as typeof fetch,
    });
    void NL;
    for await (const _c of client.stream({
      model: 'm',
      messages: [{ role: 'user', content: 'hi', attachments: [{ kind: 'image', ref: 'f.png' }] }] as never[],
      meta: { runId: 'r1' },
    }));
    const body = JSON.parse(captured.init.body);
    expect('meta' in body).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});