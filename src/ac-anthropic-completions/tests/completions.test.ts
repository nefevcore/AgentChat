import { describe, it, expect } from 'vitest';
import { AnthropicCompletions, toAnthropicMessages, toAnthropicTools, mapAnthropicUsage, mapFinishReason, createAnthropicChunkMapper } from '../src/index';

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

describe('toAnthropicMessages', () => {
  it('system 抽出顶层 + tool_calls → tool_use 块 + tool 角色 → user tool_result', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'thinking...', tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
    ]);
    expect(out.system).toBe('sys');
    expect(out.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }, { type: 'tool_use', id: 't1', name: 'read', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]);
  });
});

describe('toAnthropicTools', () => {
  it('OpenAI function 嵌套 → 扁平 {name, description, input_schema}', () => {
    const out = toAnthropicTools([{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }]);
    expect(out).toEqual([{ name: 'read', description: 'd', input_schema: { type: 'object' } }]);
  });
});

describe('mapFinishReason / mapAnthropicUsage', () => {
  it('tool_use → tool_calls；cache 归一', () => {
    expect(mapFinishReason('tool_use')).toBe('tool_calls');
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapAnthropicUsage({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 60 })).toEqual({
      prompt: 100, completion: 5, cacheHit: 60, cacheMiss: 40,
    });
  });
});

describe('createAnthropicChunkMapper', () => {
  it('text/tool_use/input_json_delta/thinking/message_delta 全事件链', () => {
    const m = createAnthropicChunkMapper();
    expect(m({ type: 'message_start', message: { usage: { input_tokens: 3 } } })).toEqual({ delta: '', usage: { prompt: 3, completion: 0 } });
    expect(m({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })).toBeNull();
    expect(m({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })).toEqual({ delta: 'hi' });
    expect(m({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'th' } })).toEqual({ delta: '', reasoning: 'th' });
    expect(m({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'read' } })).toEqual({
      delta: '', toolCalls: [{ index: 0, id: 'tu1', name: 'read', argumentsDelta: '' }],
    });
    expect(m({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } })).toEqual({
      delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"a":1}' }],
    });
    expect(m({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })).toEqual({
      delta: '', finish: 'tool_calls', usage: { prompt: 0, completion: 7 },
    });
    expect(m({ type: 'ping' })).toBeNull();
  });
});

describe('AnthropicCompletions.stream（SSE 全链路）', () => {
  it('x-api-key + anthropic-version 头 + system 顶层 + 聚合 text/usage', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new AnthropicCompletions({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com',
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        return sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
          { type: 'message_delta', delta: { stop_reason: 'stop' }, usage: { output_tokens: 2 } },
        ]);
      }) as unknown as typeof fetch,
    });
    const chunks: unknown[] = [];
    for await (const c of client.stream({ model: 'claude-sonnet-4-5', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] })) chunks.push(c);
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.init.headers['x-api-key']).toBe('sk-ant');
    expect(captured.init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(captured.init.body);
    expect(body.system).toBe('s');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBe(4096);
    expect(chunks.at(-1)).toEqual({ delta: '', finish: 'stop', usage: { prompt: 0, completion: 2 } });
  });

  it('api_key 传输层键单次覆盖；provider/headers 剥离不进 body', async () => {
    const captured: { init?: any } = {};
    const client = new AnthropicCompletions({
      fetchImpl: (async (_url: any, init: any) => {
        captured.init = init;
        return sseResponse([{ type: 'message_delta', delta: { stop_reason: 'stop' } }]);
      }) as unknown as typeof fetch,
    });
    for await (const _c of client.stream({ model: 'm', messages: [], api_key: 'sk-per', provider: 'px', headers: { 'x-session': 's1' } }));
    expect(captured.init.headers['x-api-key']).toBe('sk-per');
    expect(captured.init.headers['x-session']).toBe('s1');
    const body = JSON.parse(captured.init.body);
    expect('provider' in body).toBe(false);
    expect('api_key' in body).toBe(false);
  });

  it('HTTP 错误透传（401 文案前缀）', async () => {
    const client = new AnthropicCompletions({
      fetchImpl: (async () => new Response('{"error":"auth"}', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.stream({ model: 'm', messages: [] }).next()).rejects.toThrow(/LLM HTTP 401/);
  });
});

describe('AnthropicCompletions.listModels', () => {
  it('GET /v1/models + x-api-key，返回字典序', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new AnthropicCompletions({
      fetchImpl: (async (url: any, init: any) => {
        captured.url = url;
        captured.init = init;
        return new Response(JSON.stringify({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const models = await client.listModels({ api_key: 'k' });
    expect(captured.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(captured.init.headers['x-api-key']).toBe('k');
    expect(models).toEqual(['claude-a', 'claude-b']);
  });

  it('close 后拒绝调用', async () => {
    const client = new AnthropicCompletions({
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    client.close();
    await expect(client.listModels()).rejects.toThrow(/已 close/);
  });
});

describe('thinking 回放（cr-98：签名捕获 → 历史重建）', () => {
  it('content_block_stop 的 signature 经映射器透传（thinkingSignature chunk）', () => {
    const map = createAnthropicChunkMapper();
    expect(map({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })).toBeNull();
    expect(map({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '让我想想' } }))
      .toEqual({ delta: '', reasoning: '让我想想' });
    expect(map({ type: 'content_block_stop', index: 0, content_block: { type: 'thinking', signature: 'sig-abc' } }))
      .toEqual({ delta: '', thinkingSignature: 'sig-abc' });
    // 非 thinking 块的 stop 不发 signature
    expect(map({ type: 'content_block_stop', index: 1, content_block: { type: 'text' } })).toBeNull();
  });

  it('assistant 历史（reasoning + thinkingSignature + tool_calls）重建 thinking 块', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'user', content: '查一下' },
      {
        role: 'assistant',
        content: '',
        reasoning: '先调工具',
        thinkingSignature: 'sig-abc',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: '结果' },
    ] as never);
    expect(system).toBeUndefined();
    const assistant = messages[1] as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: '先调工具', signature: 'sig-abc' });
    expect(assistant.content[1]).toMatchObject({ type: 'tool_use', id: 't1', name: 'search' });
    // tool 结果照常映射
    expect(messages[2]).toMatchObject({ role: 'user' });
  });

  it('无签名的历史不重建 thinking 块（DeepSeek/GLM 等其余协议零影响）', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: '正文', reasoning: '纯思考', tool_calls: [] },
    ] as never);
    // 无签名 → 不走重建分支：纯文本原样直传（string content，与旧行为一致）
    expect(messages[0]).toEqual({ role: 'assistant', content: '正文' });
  });
});
