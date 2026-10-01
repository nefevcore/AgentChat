// ============================================================
// ac-ollama-completions —— Ollama 原生 /api/chat 纯库
//
// 【定位（llm-protocol-extensibility 备忘 cr-39 实施）】共享协议实现库，
// **不是 provider/插件行**：零 cordis 依赖、不出现在 cordis.yml——
// provider 注册唯一入口是 ac-llm-pool（池条目 protocol='ollama'）。
// 与 ac-openai-completions 同款纪律：返回形状与 ac-llm 的 LlmProvider
// 结构化兼容。
//
// 线格式（Ollama Chat API，NDJSON——每行一个 JSON 对象，无 SSE 包装）：
//   · 请求体 { model, messages, tools?, stream:true, options? }；
//   · 鉴权：本地端点免鉴权；远程（如 ollama.com）Bearer（缺省不发送）；
//   · 流行 { message: { role:'assistant', content, thinking? }, done }；
//   · 终行 { done:true, total_duration, prompt_eval_count, eval_count }；
//   · 工具调用：message.tool_calls = [{ function: { name, arguments } }]
//     （整段到达——Ollama 无参数增量）；工具结果回传 role:'tool' 原样。
// ============================================================

export interface OllamaOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  /** 无进展超时毫秒（缺省 180000；≤0 禁用）——语义同 ac-openai-completions */
  timeoutMs?: number;
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface OllamaMessage {
  role: string;
  content: string;
  /** 传输层键（协议内转换前剥离，绝不进 body） */
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface OllamaUsage {
  prompt: number;
  completion: number;
  total?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

export interface OllamaToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface OllamaChunk {
  delta: string;
  reasoning?: string;
  toolCalls?: OllamaToolCallDelta[];
  finish?: string;
  usage?: OllamaUsage;
}

export interface OllamaChatResult {
  model: string;
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finish?: string;
  usage?: OllamaUsage;
}

export interface OllamaRequest {
  model?: string;
  messages: OllamaMessage[];
  signal?: AbortSignal;
  /** 传输层键：序列化请求体前剥离（同 openai 库 api_key/provider 纪律） */
  api_key?: string;
  provider?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

import { LlmHttpError, parseRetryAfter } from 'ac-error-core';
import { stripTransportKeys } from 'ac-openai-completions';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * NDJSON 行流解析（每行一个 JSON；\n 分隔，兼容 \r\n 与结尾残行）。
 * Ollama 无 SSE 包装——与 sseDataEvents 同位置的协议配套件。
 */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 中性消息序 → Ollama messages（导出测试锁定）：system 保留在
 * messages 内（Ollama 收 system 角色）；role:tool 原样（Ollama natively
 * 支持）；assistant tool_calls 原样透传（同为 OpenAI 形态——仅剥
 * attachments 传输键）。
 */
export function toOllamaMessages(messages: OllamaMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const { attachments: _attachments, ...rest } = m;
    return rest;
  });
}

/**
 * 中性采样参数 → Ollama options 嵌套对象（temperature/top_p/
 * num_predict/stop）。未知键不透传——Ollama 顶层只有 model/messages/
 * tools/stream/options/format。
 */
export function toOllamaOptions(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const opts: Record<string, unknown> = {};
  if (params.temperature !== undefined) opts.temperature = params.temperature;
  if (params.top_p !== undefined) opts.top_p = params.top_p;
  if (params.max_tokens !== undefined) opts.num_predict = params.max_tokens;
  if (params.stop !== undefined) opts.stop = Array.isArray(params.stop) ? params.stop : [params.stop];
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/** 工具规格：OpenAI function 嵌套 → Ollama 形态（同 OpenAI——直接透传） */
export function toOllamaTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools as Array<Record<string, unknown>>;
}

/** Ollama 终行 → 中性 usage（prompt_eval_count/eval_count；0/0 无效） */
export function mapOllamaUsage(raw: unknown): OllamaUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as { prompt_eval_count?: unknown; eval_count?: unknown };
  const prompt = Number(r.prompt_eval_count ?? 0);
  const completion = Number(r.eval_count ?? 0);
  if (prompt === 0 && completion === 0) return undefined;
  return { prompt, completion, total: prompt + completion };
}

/**
 * Ollama NDJSON 行 → 中性分片（有状态映射器）：
//   · message.content → delta；message.thinking → reasoning；
//   · message.tool_calls 整段 → toolCalls 分片（arguments 已是 JSON
//     字符串或对象——统一 stringify；index 递增）；
//   · done:true 终行 → finish + usage（prompt_eval_count/eval_count）。
 */
export function createOllamaChunkMapper(): (json: unknown) => OllamaChunk | null {
  let tcCount = 0;
  return (json) => {
    const r = (json ?? {}) as {
      message?: {
        role?: string; content?: unknown; thinking?: unknown;
        tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>;
      }; done?: unknown;
      prompt_eval_count?: unknown; eval_count?: unknown;
    };
    let delta = '';
    let reasoning = '';
    const toolCalls: OllamaToolCallDelta[] = [];
    if (typeof r.message?.content === 'string') delta += r.message.content;
    if (typeof r.message?.thinking === 'string') reasoning += r.message.thinking;
    const rawCalls = r.message?.tool_calls;
    if (Array.isArray(rawCalls)) {
      for (const tc of rawCalls) {
        const name = String(tc.function?.name ?? '');
        if (!name) continue;
        const args = tc.function?.arguments;
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
        toolCalls.push({ index: tcCount++, id: 'call_' + (tcCount - 1), name, argumentsDelta: argsStr });
      }
    }
    if (r.done === true) {
      const usage = mapOllamaUsage(r);
      const finish = toolCalls.length > 0 ? 'tool_calls' : 'stop';
      if (delta === '' && reasoning === '' && toolCalls.length === 0) {
        return usage !== undefined ? { delta: '', finish, usage } : null;
      }
      return { delta, ...(reasoning !== '' ? { reasoning } : {}), ...(toolCalls.length > 0 ? { toolCalls } : {}), finish, ...(usage !== undefined ? { usage } : {}) };
    }
    if (delta === '' && reasoning === '' && toolCalls.length === 0) return null;
    const chunk: OllamaChunk = { delta };
    if (reasoning !== '') chunk.reasoning = reasoning;
    if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
    return chunk;
  };
}

/** HTTP 错误响应 → LlmHttpError（读 body 文案 + Retry-After 头；cr-98） */
async function httpError(response: Response): Promise<LlmHttpError> {
  const text = await response.text().catch(() => '');
  return new LlmHttpError(response.status, `LLM HTTP ${response.status}: ${text.slice(0, 500)}`, parseRetryAfter(response.headers.get('retry-after')));
}

export class OllamaCompletions {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly defaultModel?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: OllamaOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(params: OllamaRequest): AsyncGenerator<OllamaChunk, void, void> {
    if (this.closed) throw new Error('OllamaCompletions 已 close');
    const model = params.model ?? this.defaultModel;
    if (!model) throw new Error('model 未指定（params.model 或构造参数 defaultModel）');
    const { signal, api_key, provider: _provider, headers: extraHeaders, ...restParams } = params;
    const restStripped = stripTransportKeys(restParams as Record<string, unknown>);
    const authKey = api_key || this.apiKey;
    const { messages, tools, ...rest } = restParams as Record<string, unknown>;
    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(messages as OllamaMessage[]),
      stream: true,
    };
    const opts = toOllamaOptions(rest);
    if (opts !== undefined) body.options = opts;
    const ollamaTools = toOllamaTools(tools);
    if (ollamaTools !== undefined) body.tools = ollamaTools;
    const controller = new AbortController();
    this.controllers.add(controller);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armProgressTimeout = () => {
      if (this.timeoutMs <= 0) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error('LLM 响应超时（' + Math.round(this.timeoutMs / 1000) + 's 无进展：建连、响应头或流式数据）')),
        this.timeoutMs,
      );
      timer.unref();
    };
    try {
      armProgressTimeout();
      const response = await this.fetchImpl(this.baseUrl + '/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authKey ? { authorization: 'Bearer ' + authKey } : {}),
          ...this.headers,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw await httpError(response);
      if (!response.body) throw new Error('LLM 响应缺少 body');
      armProgressTimeout();
      const mapEvent = createOllamaChunkMapper();
      for await (const line of ndjsonLines(response.body)) {
        armProgressTimeout();
        let json: unknown;
        try { json = JSON.parse(line); } catch { throw new Error('LLM NDJSON 数据解析失败: ' + line.slice(0, 200)); }
        const chunk = mapEvent(json);
        if (chunk) yield chunk;
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  /** GET /api/tags 模型发现（Ollama 原生清单端点；本地免鉴权） */
  async listModels(params: { api_key?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string[]> {
    if (this.closed) throw new Error('OllamaCompletions 已 close');
    const authKey = params.api_key || this.apiKey;
    const response = await this.fetchImpl(this.baseUrl + '/api/tags', {
      headers: {
        ...(authKey ? { authorization: 'Bearer ' + authKey } : {}),
        ...this.headers,
        ...params.headers,
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) throw await httpError(response);
    const json = (await response.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) throw new Error('LLM /api/tags 响应缺少 models 数组（非 Ollama 端点）');
    return json.models
      .map((m) => String((m as { name?: unknown }).name ?? '')).filter(Boolean).sort();
  }

  /** stream 的聚合语法糖（同 openai 库 chat 形态） */
  async chat(params: OllamaRequest): Promise<OllamaChatResult> {
    const model = params.model ?? this.defaultModel ?? '';
    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let usage: OllamaUsage | undefined;
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
      if (chunk.usage) usage = { ...usage, ...chunk.usage };
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
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}