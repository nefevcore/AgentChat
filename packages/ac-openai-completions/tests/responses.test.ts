// ============================================================
// ac-openai-completions Responses API 线格式测试（api:'responses'，
// 2026-09-10 扩展——对齐 DSH/pi-ai 的 openai-responses 面）：
// 请求构建（input 序/工具扁平/参数改名）· 事件流映射（delta/工具调用/
// 收尾 usage）· output_item.done 兜底 · probeVision Responses 形状
// ============================================================
import { describe, it, expect } from 'vitest';
import { OpenAICompletions, toResponsesInput, buildResponsesBody } from '../src/index';

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
  const body = textStream(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''));
  return new Response(body, { status });
}

function jsonFetch(captured: { url?: unknown; init?: any }, respond: () => Response): typeof fetch {
  return (async (url: any, init: any) => {
    captured.url = url;
    captured.init = init;
    return respond();
  }) as unknown as typeof fetch;
}

describe('toResponsesInput（消息序 → input 序）', () => {
  it('纯文本原样；assistant+tool_calls 拆 function_call；tool → function_call_output；空 content 消息不发', () => {
    expect(
      toResponsesInput([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      ]),
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ]);
  });

  it('多模态块 → input_text / input_image；GLM 方言块降级占位', () => {
    expect(
      toResponsesInput([
        {
          role: 'user',
          content: [
            { type: 'text', text: '看' },
            { type: 'image_url', image_url: { url: 'https://x/a.png', detail: 'low' } },
            { type: 'video_url', video_url: { url: 'https://x/a.mp4' } },
          ],
        },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '看' },
          { type: 'input_image', image_url: { url: 'https://x/a.png', detail: 'low' } },
          { type: 'input_text', text: '[video_url 附件在 Responses 格式下不支持]' },
        ],
      },
    ]);
  });
});

describe('buildResponsesBody（参数改名与方言剥离）', () => {
  it('max_tokens→max_output_tokens；reasoning_effort→reasoning.effort；丢弃 stream_options/stop；tools 扁平化', () => {
    const body = buildResponsesBody(
      {
        max_tokens: 512,
        reasoning_effort: 'low',
        stop: ['END'],
        stream_options: { include_usage: true },
        temperature: 0.5,
        tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } }],
      },
      [{ role: 'user', content: 'q' }],
      'gpt-5',
    );
    expect(body).toMatchObject({
      stream: true,
      model: 'gpt-5',
      max_output_tokens: 512,
      reasoning: { effort: 'low' },
      temperature: 0.5,
      input: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', name: 'read', description: 'd', parameters: { type: 'object' } }],
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('stream_options');
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('messages');
  });

  it('未设置的可选项不落键（无 max_tokens/reasoning_effort/tools 时）', () => {
    const body = buildResponsesBody({}, [{ role: 'user', content: 'q' }], 'm');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('tools');
  });
});

describe('OpenAICompletions（api:responses）事件流', () => {
  it('工具调用端到端：added→arguments 增量→completed（finish tool_calls + usage 缓存归一）', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new OpenAICompletions({
      api: 'responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk',
      fetchImpl: jsonFetch(captured, () =>
        sseResponse([
          { type: 'response.output_item.added', item_id: 'fc_1', item: { type: 'function_call', call_id: 'call_1', name: 'read' } },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"file_' },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'path":"a"}' },
          { type: 'response.output_text.delta', delta: '先读文件' },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 6 } } },
          },
        ]),
      ),
    });
    const result = await client.chat({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      max_tokens: 512,
      reasoning_effort: 'low',
    });
    // 请求形态：/responses 端点 + input 序 + 改名参数
    expect(captured.url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(captured.init.body);
    expect(body.input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ]);
    expect(body).toMatchObject({ max_output_tokens: 512, reasoning: { effort: 'low' } });
    // 结果聚合：与 chat/completions 同一 CompletionsChatResult 契约
    expect(result.text).toBe('先读文件');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' }]);
    expect(result.finish).toBe('tool_calls');
    expect(result.usage).toEqual({ prompt: 10, completion: 4, total: 14, cacheHit: 6, cacheMiss: 4 });
  });

  it('reasoning 增量 → reasoning 聚合；无工具调用 → finish stop', async () => {
    const client = new OpenAICompletions({
      api: 'responses',
      fetchImpl: jsonFetch({}, () =>
        sseResponse([
          { type: 'response.reasoning_summary_text.delta', delta: '想一想' },
          { type: 'response.output_text.delta', delta: '答案' },
          { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        ]),
      ),
    });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(result.text).toBe('答案');
    expect(result.reasoning).toBe('想一想');
    expect(result.finish).toBe('stop');
    expect(result.usage).toEqual({ prompt: 1, completion: 1 });
  });

  it('output_item.done 兜底：只发 done 不发 arguments 增量的网关按整段补发', async () => {
    const client = new OpenAICompletions({
      api: 'responses',
      fetchImpl: jsonFetch({}, () =>
        sseResponse([
          { type: 'response.output_item.added', item_id: 'fc_1', item: { type: 'function_call', call_id: 'call_1', name: 'read' } },
          { type: 'response.output_item.done', item_id: 'fc_1', item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"x":1}' } },
          { type: 'response.completed', response: {} },
        ]),
      ),
    });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read', arguments: '{"x":1}' }]);
  });

  it('incomplete → finish length；failed 事件 → 抛错', async () => {
    const cut = new OpenAICompletions({
      api: 'responses',
      fetchImpl: jsonFetch({}, () => sseResponse([{ type: 'response.incomplete', response: {} }])),
    });
    expect((await cut.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] })).finish).toBe('length');
    const boom = new OpenAICompletions({
      api: 'responses',
      fetchImpl: jsonFetch({}, () =>
        sseResponse([{ type: 'response.failed', response: { error: { message: 'boom' } } }]),
      ),
    });
    await expect(boom.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(/boom/);
  });
});

describe('probeVision（api:responses 形状）', () => {
  it('探测打 /responses + input_image/input_text 块；2xx → true', async () => {
    const captured: { url?: unknown; init?: any } = {};
    const client = new OpenAICompletions({
      api: 'responses',
      fetchImpl: jsonFetch(captured, () => new Response('{"id":"r"}', { status: 200 })),
    });
    expect(await client.probeVision('gpt-5')).toBe(true);
    expect(captured.url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(captured.init.body)).toMatchObject({
      model: 'gpt-5', stream: false, max_output_tokens: 1,
      input: [{ role: 'user', content: [{ type: 'input_image' }, { type: 'input_text', text: '1' }] }],
    });
  });

  it('400 → false（拒图三态语义不变）', async () => {
    const client = new OpenAICompletions({
      api: 'responses',
      fetchImpl: jsonFetch({}, () => new Response('{"error":{}}', { status: 400 })),
    });
    expect(await client.probeVision('t-1')).toBe(false);
  });
});
