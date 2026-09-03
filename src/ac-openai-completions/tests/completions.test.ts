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

describe('attachments 物化（多模态传输边界）', () => {
  /** 捕获请求体消息的快捷件 */
  async function bodyMessagesOf(
    options: ConstructorParameters<typeof OpenAICompletions>[0],
    messages: Array<{ role: string; content: unknown; attachments?: unknown }>,
    model = 'vision-x',
  ): Promise<any[]> {
    const captured: { init?: any } = {};
    const client = new OpenAICompletions({
      ...options,
      fetchImpl: jsonFetch(captured, () => sseResponse(['[DONE]'])),
    });
    await client.chat({ model, messages: messages as any });
    return JSON.parse(captured.init.body).messages;
  }

  it('视觉模型 + user 消息：物化为 [text, image_url] 块，attachments 键不进 body', async () => {
    const messages = await bodyMessagesOf(
      {
        visionModels: ['vision-x'],
        resolveMedia: async (ref) => `data:image/png;base64,${ref}`,
      },
      [
        {
          role: 'user',
          content: '看图',
          attachments: [{ kind: 'image', ref: 'files/a/_tmp/x.png', filename: 'x.png', detail: 'low' }],
        },
      ],
    );
    expect(messages[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,files/a/_tmp/x.png', detail: 'low' } },
    ]);
    expect(messages[0]).not.toHaveProperty('attachments');
  });

  it('http(s) 引用直传 provider，不经 resolveMedia', async () => {
    const resolved: string[] = [];
    const messages = await bodyMessagesOf(
      {
        visionModels: ['*'],
        resolveMedia: async (ref) => {
          resolved.push(ref);
          return 'data:image/png;base64,zz';
        },
      },
      [{ role: 'user', content: '', attachments: [{ kind: 'image', ref: 'https://cdn.example.com/a.jpg' }] }],
    );
    expect(resolved).toEqual([]);
    expect(messages[0].content).toEqual([{ type: 'image_url', image_url: { url: 'https://cdn.example.com/a.jpg' } }]);
  });

  it('非视觉模型：attachments 剥离、content 保持字符串（非视觉模型不 400）', async () => {
    const messages = await bodyMessagesOf(
      { visionModels: ['other-v'], resolveMedia: async () => 'data:image/png;base64,zz' },
      [{ role: 'user', content: '看图\n[附件] files/a/_tmp/x.png', attachments: [{ kind: 'image', ref: 'files/a/_tmp/x.png' }] }],
    );
    expect(messages[0].content).toBe('看图\n[附件] files/a/_tmp/x.png');
    expect(messages[0]).not.toHaveProperty('attachments');
  });

  it('visionModels 未配置：一律剥离（fail-closed）', async () => {
    const messages = await bodyMessagesOf(
      { resolveMedia: async () => 'data:image/png;base64,zz' },
      [{ role: 'user', content: 'q', attachments: [{ kind: 'image', ref: 'files/a/_tmp/x.png' }] }],
    );
    expect(messages[0].content).toBe('q');
    expect(messages[0]).not.toHaveProperty('attachments');
  });

  it('前缀/通配匹配：vision-x-mini 命中 vision-x 前缀；* 全放行', async () => {
    const resolved = async () => 'data:image/png;base64,zz';
    const byPrefix = await bodyMessagesOf(
      { visionModels: ['vision-x'], resolveMedia: resolved },
      [{ role: 'user', content: 'q', attachments: [{ kind: 'image', ref: 'files/a.png' }] }],
      'vision-x-mini',
    );
    expect(Array.isArray(byPrefix[0].content)).toBe(true);
  });

  it('物化失败（无 resolver / ref 缺文件）→ 降级文本占位块，不炸请求', async () => {
    const messages = await bodyMessagesOf(
      { visionModels: ['vision-x'] }, // 无 resolveMedia
      [{ role: 'user', content: '看', attachments: [{ kind: 'image', ref: 'files/gone.png', filename: 'gone.png' }] }],
    );
    expect(messages[0].content).toEqual([
      { type: 'text', text: '看' },
      { type: 'text', text: '[图片无法加载: gone.png]' },
    ]);
  });

  it('非 user 角色带 attachments：剥离（图片仅 user 位合法）', async () => {
    const messages = await bodyMessagesOf(
      { visionModels: ['*'], resolveMedia: async () => 'data:image/png;base64,zz' },
      [
        { role: 'system', content: 'sys', attachments: [{ kind: 'image', ref: 'files/a.png' }] },
        { role: 'user', content: 'hi' },
      ],
    );
    expect(messages[0].content).toBe('sys');
    expect(messages[0]).not.toHaveProperty('attachments');
  });

  it('无 attachments 的消息：请求体形状与既有完全一致（零回归）', async () => {
    const captured: { init?: any } = {};
    const client = new OpenAICompletions({ fetchImpl: jsonFetch(captured, () => sseResponse(['[DONE]'])) });
    await client.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    expect(JSON.parse(captured.init.body).messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('video 附件：http 引用 → video_url 块；workspace 引用 → 降级占位（M4）', async () => {
    const messages = await bodyMessagesOf(
      {
        visionModels: ['vision-x'],
        resolveMedia: async () => 'data:video/mp4;base64,zz',
      },
      [
        { role: 'user', content: '看视频', attachments: [{ kind: 'video', ref: 'https://cdn.example.com/a.mp4', filename: 'a.mp4' }] },
        { role: 'user', content: '本地视频', attachments: [{ kind: 'video', ref: 'files/user/_tmp/b.mp4', filename: 'b.mp4' }] },
      ],
    );
    expect(messages[0].content).toEqual([
      { type: 'text', text: '看视频' },
      { type: 'video_url', video_url: { url: 'https://cdn.example.com/a.mp4' } },
    ]);
    expect(messages[1].content).toEqual([
      { type: 'text', text: '本地视频' },
      { type: 'text', text: '[视频仅支持 URL 引用: b.mp4]' },
    ]);
  });

  it('file 附件：http → file_url；workspace → resolveMedia 物化 file_data（GLM 形状）', async () => {
    const messages = await bodyMessagesOf(
      {
        visionModels: ['*'],
        resolveMedia: async (ref) => `data:application/pdf;base64,${ref}`,
      },
      [
        {
          role: 'user', content: '读文档',
          attachments: [
            { kind: 'file', ref: 'https://cdn.example.com/a.pdf', filename: 'a.pdf' },
            { kind: 'file', ref: 'files/user/_tmp/b.pdf', filename: 'b.pdf' },
          ],
        },
      ],
    );
    expect(messages[0].content).toEqual([
      { type: 'text', text: '读文档' },
      { type: 'file', file: { file_url: 'https://cdn.example.com/a.pdf', filename: 'a.pdf' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,files/user/_tmp/b.pdf', filename: 'b.pdf' } },
    ]);
  });

  it('附件超出单条 50 上限：截断 + 溢出行（与 deliver 入口上限对齐）', async () => {
    const many = Array.from({ length: 53 }, (_, i) => ({ kind: 'image' as const, ref: `https://cdn.example.com/${i}.png` }));
    const messages = await bodyMessagesOf(
      { visionModels: ['vision-x'] },
      [{ role: 'user', content: '多图', attachments: many }],
    );
    const blocks = messages[0].content as any[];
    const imageBlocks = blocks.filter((b) => b.type === 'image_url');
    expect(imageBlocks).toHaveLength(50);
    expect(blocks.at(-1)).toEqual({ type: 'text', text: '[其余 3 个附件未发送（超出单条 50 上限）]' });
  });

  it('未知 kind（词表外）项被过滤，不进块也不炸', async () => {
    const messages = await bodyMessagesOf(
      { visionModels: ['vision-x'], resolveMedia: async () => 'data:image/png;base64,zz' },
      [{ role: 'user', content: 'q', attachments: [{ kind: 'audio' as never, ref: 'files/a.mp3' }, { kind: 'image', ref: 'files/ok.png' }] }],
    );
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'q' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,zz' } },
    ]);
  });
});

describe('probeVision（视觉能力探测：三态判定）', () => {
  function probeFetch(status: number, captured: { body?: any } = {}): typeof fetch {
    return (async (_url: any, init: any) => {
      captured.body = JSON.parse(init.body);
      return new Response('{"choices":[]}', { status });
    }) as unknown as typeof fetch;
  }

  it('2xx → true；请求体 = 1×1 图块 + 最小文本 + max_tokens 1（非流式）', async () => {
    const captured: { body?: any } = {};
    const client = new OpenAICompletions({ apiKey: 'sk', fetchImpl: probeFetch(200, captured) });
    expect(await client.probeVision('v-1', { api_key: 'sk-x' })).toBe(true);
    expect(captured.body).toMatchObject({
      model: 'v-1', stream: false, max_tokens: 1,
      messages: [{ role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: '1' }] }],
    });
  });

  it('400 → false（文本模型拒图）', async () => {
    const client = new OpenAICompletions({ fetchImpl: probeFetch(400) });
    expect(await client.probeVision('t-1')).toBe(false);
  });

  it('401/429/5xx → undefined（未知——凭据错/限流不可归因为拒图）', async () => {
    for (const status of [401, 429, 500]) {
      const client = new OpenAICompletions({ fetchImpl: probeFetch(status) });
      expect(await client.probeVision('m')).toBeUndefined();
    }
  });

  it('网络异常 → undefined（不抛错）', async () => {
    const client = new OpenAICompletions({
      fetchImpl: (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
    });
    expect(await client.probeVision('m')).toBeUndefined();
  });
});
