// ============================================================
// ac-gemini-completions —— Google Gemini 原生 generateContent 纯库
//
// 【定位（llm-protocol-extensibility 备忘 cr-39 实施）】共享协议实现库，
// **不是 provider/插件行**：零 cordis 依赖、不出现在 cordis.yml——
// provider 注册唯一入口是 ac-llm-pool（池条目 protocol='gemini'）。
// 与 ac-openai-completions 同款纪律：返回形状与 ac-llm 的 LlmProvider
// 结构化兼容。
//
// 线格式（Gemini generateContent）：
//   · 端点 POST {base}/v1beta/models/{model}:streamGenerateContent
//     ?alt=sse（模型名进 URL 路径——非 body）；
//   · 鉴权 x-goog-api-key 头（不进 query，避免 URL 泄 key）；
//   · 请求体 { contents, systemInstruction?, tools?, generationConfig? }；
//   · SSE data JSON：candidates[0].content.parts[]（text / thought /
//     functionCall 整段）+ usageMetadata + finishReason；
//   · tool 结果回传 = user 消息 functionResponse part。
// ============================================================
import { sseDataEvents } from 'ac-openai-completions';

export interface GeminiOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  /** 无进展超时毫秒（缺省 180000；≤0 禁用）——语义同 ac-openai-completions */
  timeoutMs?: number;
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface GeminiMessage {
  role: string;
  content: string;
  /** 传输层键（协议内转换前剥离，绝不进 body） */
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface GeminiUsage {
  prompt: number;
  completion: number;
  total?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

export interface GeminiToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface GeminiChunk {
  delta: string;
  reasoning?: string;
  toolCalls?: GeminiToolCallDelta[];
  finish?: string;
  usage?: GeminiUsage;
}

export interface GeminiChatResult {
  model: string;
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finish?: string;
  usage?: GeminiUsage;
}

export interface GeminiRequest {
  model?: string;
  messages: GeminiMessage[];
  signal?: AbortSignal;
  /** 传输层键：序列化请求体前剥离（同 openai 库 api_key/provider 纪律） */
  api_key?: string;
  provider?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_TIMEOUT_MS = 180_000;

/** Gemini finishReason → 中性 finish（STOP 统一 stop；MALFORMED 等原值
 * 透传——调用方可诊断） */
export function mapGeminiFinishReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  if (reason === 'STOP') return 'stop';
  return reason;
}

/** usageMetadata → 中性（promptTokenCount/candidatesTokenCount/总与缓存） */
export function mapGeminiUsage(raw: unknown): GeminiUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as {
    promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown;
    cachedContentTokenCount?: unknown; thoughtsTokenCount?: unknown;
  };
  const prompt = Number(r.promptTokenCount ?? 0);
  const completion = Number(r.candidatesTokenCount ?? 0) + Number(r.thoughtsTokenCount ?? 0);
  const usage: GeminiUsage = { prompt, completion };
  if (r.totalTokenCount != null) usage.total = Number(r.totalTokenCount);
  const cached = Number(r.cachedContentTokenCount ?? 0);
  if (cached > 0) {
    usage.cacheHit = cached;
    usage.cacheMiss = Math.max(0, prompt - cached);
  }
  return usage;
}

/**
 * 中性消息序 → Gemini contents + systemInstruction（导出测试锁定）：
//   · system → systemInstruction.parts（Gemini 不收 contents 内 system）；
//   · role assistant → 'model'，user/tool → 'user'；
//   · assistant 带 tool_calls → parts [{functionCall:{name, args}}]；
//   · role:'tool'（name=工具名）→ parts [{functionResponse:{name, response}}]；
//   · 其余原样 {role, parts:[{text}]}。
 */
export function toGeminiContents(messages: GeminiMessage[]): { systemInstruction?: string; contents: Array<Record<string, unknown>> } {
  const system: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') { if (m.content) system.push(m.content); continue; }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [{ functionResponse: { name: String(m.name ?? ''), response: safeParseJson(m.content) } }],
      });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const rawCalls = (m as { tool_calls?: unknown }).tool_calls;
    const calls = Array.isArray(rawCalls) ? rawCalls : [];
    if (calls.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of calls as Array<{ function?: { name?: unknown; arguments?: unknown } }>) {
        parts.push({ functionCall: { name: String(tc.function?.name ?? ''), args: safeParseJson(tc.function?.arguments) } });
      }
      out.push({ role, parts });
      continue;
    }
    out.push({ role, parts: [{ text: m.content }] });
  }
  return { ...(system.length ? { systemInstruction: system.join('\n\n') } : {}), contents: out };
}

/** 工具规格（OpenAI function 嵌套）→ Gemini functionDeclarations 扁平形态 */
export function toGeminiTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const decls: Array<Record<string, unknown>> = [];
  for (const t of tools) {
    const spec = t as { type?: string; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    if (spec.type === 'function' && spec.function) {
      decls.push({
        name: String(spec.function.name ?? ''),
        ...(spec.function.description ? { description: String(spec.function.description) } : {}),
        ...(spec.function.parameters ? { parameters: spec.function.parameters } : {}),
      });
    }
  }
  return decls.length > 0 ? [{ functionDeclarations: decls }] : undefined;
}

/**
 * 中性采样参数 → generationConfig（Gemini 把采样参数收进嵌套对象；
 * temperature/topP/maxOutputTokens/stopSequences）。未知键不透传。
 */
export function toGeminiGenerationConfig(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {};
  if (params.temperature !== undefined) cfg.temperature = params.temperature;
  if (params.top_p !== undefined) cfg.topP = params.top_p;
  if (params.max_tokens !== undefined) cfg.maxOutputTokens = params.max_tokens;
  if (params.stop !== undefined) cfg.stopSequences = Array.isArray(params.stop) ? params.stop : [params.stop];
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Gemini SSE data JSON → 中性分片（有状态映射器）。functionCall 是整段
 * 到达（Gemini 无参数增量）——每次发完整 arguments 一次（chat 聚合器
 * 天然拼接兼容）。多 candidates 只取 [0]。
 */
export function createGeminiChunkMapper(): (json: unknown) => GeminiChunk | null {
  let tcCount = 0;
  return (json) => {
    const r = (json ?? {}) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: unknown; thought?: unknown; functionCall?: { name?: unknown; args?: unknown } }> };
        finishReason?: unknown;
      }>; usageMetadata?: unknown;
    };
    const candidate = r.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    let delta = '';
    let reasoning = '';
    const toolCalls: GeminiToolCallDelta[] = [];
    for (const p of parts) {
      if (typeof p.text === 'string') {
        if (p.thought === true) reasoning += p.text; else delta += p.text;
      }
      if (p.functionCall && typeof p.functionCall.name === 'string') {
        const index = tcCount++;
        toolCalls.push({ index, id: 'call_' + index, name: p.functionCall.name, argumentsDelta: JSON.stringify(p.functionCall.args ?? {}) });
      }
    }
    const finish = mapGeminiFinishReason(candidate?.finishReason as string | undefined);
    const usage = mapGeminiUsage(r.usageMetadata);
    if (delta === '' && reasoning === '' && toolCalls.length === 0 && finish === undefined && usage === undefined) return null;
    const chunk: GeminiChunk = { delta };
    if (reasoning !== '') chunk.reasoning = reasoning;
    if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
    if (finish !== undefined) chunk.finish = finish;
    if (usage !== undefined) chunk.usage = usage;
    return chunk;
  };
}

export class GeminiCompletions {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly defaultModel?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: GeminiOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(params: GeminiRequest): AsyncGenerator<GeminiChunk, void, void> {
    if (this.closed) throw new Error('GeminiCompletions 已 close');
    const model = params.model ?? this.defaultModel;
    if (!model) throw new Error('model 未指定（params.model 或构造参数 defaultModel）');
    const { signal, api_key, provider: _provider, headers: extraHeaders, ...restParams } = params;
    const authKey = api_key || this.apiKey;
    const { messages, tools, ...rest } = restParams as Record<string, unknown>;
    const mapped = toGeminiContents(messages as GeminiMessage[]);
    const body: Record<string, unknown> = {
      ...mapped.contents.length ? { contents: mapped.contents } : {},
      ...(mapped.systemInstruction !== undefined ? { systemInstruction: mapped.systemInstruction } : {}),
    };
    const geminiTools = toGeminiTools(tools);
    if (geminiTools !== undefined) body.tools = geminiTools;
    const cfg = toGeminiGenerationConfig(rest);
    if (cfg !== undefined) body.generationConfig = cfg;
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
      const url = this.baseUrl + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authKey ? { 'x-goog-api-key': authKey } : {}),
          ...this.headers,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error('LLM HTTP ' + response.status + ': ' + text.slice(0, 500));
      }
      if (!response.body) throw new Error('LLM 响应缺少 body');
      armProgressTimeout();
      const mapEvent = createGeminiChunkMapper();
      for await (const data of sseDataEvents(response.body)) {
        armProgressTimeout();
        let json: unknown;
        try { json = JSON.parse(data); } catch { throw new Error('LLM SSE 数据解析失败: ' + data.slice(0, 200)); }
        const chunk = mapEvent(json);
        if (chunk) yield chunk;
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  /**
   * GET /v1beta/models 模型发现（Gemini 原生清单端点）。返回支持
   * generateContent 的模型名清单（剥 models/ 前缀，字典序）。
   */
  async listModels(params: { api_key?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string[]> {
    if (this.closed) throw new Error('GeminiCompletions 已 close');
    const authKey = params.api_key || this.apiKey;
    const response = await this.fetchImpl(this.baseUrl + '/v1beta/models?pageSize=1000', {
      headers: {
        ...(authKey ? { 'x-goog-api-key': authKey } : {}),
        ...this.headers,
        ...params.headers,
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error('LLM HTTP ' + response.status + ': ' + text.slice(0, 500));
    }
    const json = (await response.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) throw new Error('LLM /v1beta/models 响应缺少 models 数组（非 Gemini 端点）');
    return json.models
      .filter((m) => Array.isArray((m as { supportedGenerationMethods?: unknown }).supportedGenerationMethods)
        && ((m as { supportedGenerationMethods: unknown[] }).supportedGenerationMethods.includes('generateContent')))
      .map((m) => String((m as { name?: unknown }).name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
  }

  /** stream 的聚合语法糖（同 openai 库 chat 形态） */
  async chat(params: GeminiRequest): Promise<GeminiChatResult> {
    const model = params.model ?? this.defaultModel ?? '';
    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let usage: GeminiUsage | undefined;
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