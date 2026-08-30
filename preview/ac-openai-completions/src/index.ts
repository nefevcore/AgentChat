// ============================================================
// ac-openai-completions —— OpenAI 兼容 chat completions 纯库
//
// 零 cordis 依赖、构造零 I/O（懒连接由路由器触发首次调用时发生）。
// openai / deepseek / glm 三个适配器薄行共用本库；返回形状与
// ac-llm（LLM 域契约 owning package）的 LlmProvider 结构化兼容
// ——工厂零胶水直接返回实例。
// ============================================================

export interface CompletionsOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface CompletionsMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface CompletionsUsage {
  prompt: number;
  completion: number;
  total?: number;
  /** 缓存命中的输入 token 数（provider 归一化；与 ac-llm LlmUsage 结构兼容） */
  cacheHit?: number;
  /** 缓存未命中的输入 token 数 */
  cacheMiss?: number;
}

export interface CompletionsToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface CompletionsToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionsChunk {
  delta: string;
  /** 推理增量（deepseek reasoning_content / glm thinking） */
  reasoning?: string;
  /** 工具调用分片（arguments 跨分片拼接，按 index 聚合） */
  toolCalls?: CompletionsToolCallDelta[];
  finish?: string;
  usage?: CompletionsUsage;
}

export interface CompletionsChatResult {
  model: string;
  text: string;
  reasoning?: string;
  toolCalls?: CompletionsToolCall[];
  finish?: string;
  usage?: CompletionsUsage;
}

export interface CompletionsRequest {
  model?: string;
  messages: CompletionsMessage[];
  signal?: AbortSignal;
  /**
   * 单次调用覆盖 API key（凭据链上层注入；优先于构造参数）。
   * 传输层键——序列化请求体前剥离，绝不发给服务端 body。
   */
  api_key?: string;
  /** 其余参数（temperature/max_tokens/tools/...）原样透传 */
  [key: string]: unknown;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAICompletions {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly defaultModel?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: CompletionsOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(params: CompletionsRequest): AsyncGenerator<CompletionsChunk, void, void> {
    if (this.closed) throw new Error('OpenAICompletions 已 close');
    const model = params.model ?? this.defaultModel;
    if (!model) throw new Error('model 未指定（params.model 或构造参数 defaultModel）');

    // api_key 是传输层键（单次调用覆盖构造默认）：剥离后才进 body
    const { signal, api_key, ...bodyParams } = params;
    const authKey = api_key || this.apiKey;
    const controller = new AbortController();
    this.controllers.add(controller);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authKey ? { authorization: `Bearer ${authKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({
          stream: true,
          stream_options: { include_usage: true },
          ...bodyParams,
          model,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!response.body) throw new Error('LLM 响应缺少 body');
      for await (const data of sseDataEvents(response.body)) {
        if (data === '[DONE]') return;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          throw new Error(`LLM SSE 数据解析失败: ${data.slice(0, 200)}`);
        }
        const chunk = mapChunk(json);
        if (chunk) yield chunk;
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** stream 的聚合语法糖：拼接 delta/reasoning，聚合 toolCalls，收尾 finish/usage */
  async chat(params: CompletionsRequest): Promise<CompletionsChatResult> {
    const model = params.model ?? this.defaultModel ?? '';
    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let usage: CompletionsUsage | undefined;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of this.stream(params)) {
      text += chunk.delta;
      if (chunk.reasoning) reasoning += chunk.reasoning;
      for (const frag of chunk.toolCalls ?? []) {
        const acc = toolCalls.get(frag.index) ?? { id: '', name: '', args: '' };
        if (frag.id) acc.id = frag.id;
        if (frag.name) acc.name = frag.name;
        if (frag.argumentsDelta) acc.args += frag.argumentsDelta;
        toolCalls.set(frag.index, acc);
      }
      if (chunk.finish) finish = chunk.finish;
      if (chunk.usage) usage = chunk.usage;
    }
    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: acc.args }));
    return {
      model,
      text,
      ...(reasoning ? { reasoning } : {}),
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(finish ? { finish } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  /** 中止在途请求并标记关闭（路由器回收 provider 实例时调用） */
  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

/** 解析 SSE 字节流为 data 载荷序列（规范：\n\n 分隔事件，兼容 \r\n） */
export async function* sseDataEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = extractData(event);
        if (data !== undefined) yield data;
      }
    }
    const tail = extractData(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function extractData(event: string): string | undefined {
  const data: string[] = [];
  for (const line of event.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : undefined;
}

/**
 * 原生 usage 对象 → CompletionsUsage（缓存字段归一化，src llm-openai 语义原样）：
 *   · DeepSeek：顶层 prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   · OpenAI/GLM：嵌套 prompt_tokens_details.cached_tokens
 *     （hit=cached_tokens、miss=prompt_tokens−cached_tokens 推导）
 */
export function mapUsage(raw: any): CompletionsUsage {
  const prompt = Number(raw.prompt_tokens ?? 0);
  const usage: CompletionsUsage = {
    prompt,
    completion: Number(raw.completion_tokens ?? 0),
    ...(raw.total_tokens != null ? { total: Number(raw.total_tokens) } : {}),
  };
  let cacheHit: number | undefined =
    typeof raw.prompt_cache_hit_tokens === 'number' ? raw.prompt_cache_hit_tokens : undefined;
  if (cacheHit === undefined) {
    const nested = raw.prompt_tokens_details?.cached_tokens;
    if (typeof nested === 'number') {
      cacheHit = nested;
      usage.cacheMiss = Math.max(0, prompt - nested);
    }
  } else if (typeof raw.prompt_cache_miss_tokens === 'number') {
    usage.cacheMiss = raw.prompt_cache_miss_tokens;
  }
  if (cacheHit !== undefined) usage.cacheHit = cacheHit;
  return usage;
}

/** OpenAI 兼容分片 → CompletionsChunk（空片返回 null 被跳过） */
export function mapChunk(json: any): CompletionsChunk | null {
  const choice = json?.choices?.[0];
  const delta = choice?.delta ?? {};
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  const usage = json?.usage ? mapUsage(json.usage) : undefined;
  const chunk: CompletionsChunk = {
    delta: typeof delta.content === 'string' ? delta.content : '',
  };
  if (reasoning != null) chunk.reasoning = String(reasoning);
  if (Array.isArray(delta.tool_calls)) {
    const frags: CompletionsToolCallDelta[] = [];
    for (const tc of delta.tool_calls) {
      const frag: CompletionsToolCallDelta = { index: Number(tc?.index ?? 0) };
      if (tc?.id) frag.id = String(tc.id);
      if (tc?.function?.name) frag.name = String(tc.function.name);
      if (tc?.function?.arguments) frag.argumentsDelta = String(tc.function.arguments);
      frags.push(frag);
    }
    if (frags.length) chunk.toolCalls = frags;
  }
  if (choice?.finish_reason) chunk.finish = String(choice.finish_reason);
  if (usage) chunk.usage = usage;
  if (!chunk.delta && chunk.reasoning === undefined && !chunk.toolCalls && !chunk.finish && !chunk.usage) {
    return null;
  }
  return chunk;
}
