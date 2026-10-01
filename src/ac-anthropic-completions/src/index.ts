// ============================================================
// ac-anthropic-completions —— Anthropic 原生 /v1/messages 纯库
//
// 【定位（llm-protocol-extensibility 备忘 cr-39 实施）】共享协议
// 实现库，**不是 provider/插件行**：本包不注册任何 ctx.llm provider、
// 零 cordis 依赖、不出现在 cordis.yml——provider 注册唯一入口是
// ac-llm-pool（配置驱动 llmProviders 池，条目 protocol='anthropic'）。
// 与 ac-openai-completions 同款纪律：返回形状与 ac-llm 的 LlmProvider
// 结构化兼容（协议库负责把原生响应映射成中性分片）。
//
// 线格式（Anthropic Messages API）：
//   · 鉴权头 x-api-key + anthropic-version: 2023-06-01（必需）；
//   · 请求体 { model, max_tokens(必填), messages, system?, tools? }；
//   · SSE 事件流 content_block_delta(text_delta / input_json_delta /
//     thinking_delta) / content_block_start(tool_use 出 id+name) /
//     message_delta(stop_reason + usage)；
//   · assistant 历史消息的 tool_calls 与 user 的 tool 角色按 Anthropic
//     形态互转（tool_use / tool_result content 块）。
// ============================================================
import { LlmHttpError, parseRetryAfter } from 'ac-error-core';
import { sseDataEvents, stripTransportKeys } from 'ac-openai-completions';

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  /** 无进展超时毫秒（缺省 180000；≤0 禁用）——语义同 ac-openai-completions */
  timeoutMs?: number;
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface AnthropicMessage {
  role: string;
  content: string;
  /** 传输层键（协议内转换前剥离，绝不进 body） */
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface AnthropicUsage {
  prompt: number;
  completion: number;
  total?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

export interface AnthropicToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface AnthropicChunk {
  delta: string;
  reasoning?: string;
  toolCalls?: AnthropicToolCallDelta[];
  finish?: string;
  usage?: AnthropicUsage;
  /** 思考块签名（cr-98 回放）：content_block_stop 携带——重建历史 thinking 块必需 */
  thinkingSignature?: string;
}

export interface AnthropicChatResult {
  model: string;
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finish?: string;
  usage?: AnthropicUsage;
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  signal?: AbortSignal;
  /** 传输层键：序列化请求体前剥离（同 openai 库 api_key/provider 纪律） */
  api_key?: string;
  provider?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 180_000;
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic stop_reason → 中性 finish（tool_use 统一 tool_calls） */
export function mapFinishReason(stopReason: string | null | undefined): string | undefined {
  if (!stopReason) return undefined;
  if (stopReason === 'tool_use') return 'tool_calls';
  return stopReason; // 'stop' | 'max_tokens' | 'pause_turn' | 'refusal' …
}

/** Anthropic usage → 中性（input/output_tokens；cache 嵌套归一） */
export function mapAnthropicUsage(raw: unknown): AnthropicUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as {
    input_tokens?: unknown; output_tokens?: unknown;
    cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown;
  };
  const prompt = Number(r.input_tokens ?? 0);
  const usage: AnthropicUsage = { prompt, completion: Number(r.output_tokens ?? 0) };
  const hit = Number(r.cache_read_input_tokens ?? 0);
  if (hit > 0 || Number(r.cache_creation_input_tokens ?? 0) > 0) {
    usage.cacheHit = hit;
    usage.cacheMiss = Math.max(0, prompt - hit);
  }
  return usage;
}

/**
 * 中性消息序 → Anthropic 请求形态（导出测试锁定）：
//   · system 抽出进顶层 system 参数（Anthropic 不收 messages 内 system）；
//   · assistant 带 tool_calls → content 块 [{type:'tool_use', id, name, input}]；
//   · role:'tool' → user 消息 content 块 [{type:'tool_result', tool_use_id, content}]；
//   · 其余原样（string content 直传）。
 */
export function toAnthropicMessages(messages: AnthropicMessage[]): { system?: string; messages: Array<Record<string, unknown>> } {
  const system: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') { if (m.content) system.push(m.content); continue; }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: String(m.tool_call_id ?? ''), content: typeof m.content === 'string' ? m.content : '' }],
      });
      continue;
    }
    // thinking 回放（cr-98）：Anthropic 扩展思考 + 工具调用要求回传上一 turn
    // 的 thinking 块（含签名），否则 400。assistant 消息带 reasoning +
    // thinkingSignature 时原样重建。
    const sig = (m as { thinkingSignature?: unknown }).thinkingSignature;
    if (typeof sig === 'string' && sig !== '' && typeof m.content === 'string' && m.role === 'assistant') {
      // 注意：thinking 块文本来自消息级 reasoning 字段（loop 装配时并入）
      const reasoning = (m as { reasoning?: unknown }).reasoning;
      if (typeof reasoning === 'string' && reasoning !== '') {
        const thinkBlocks: Array<Record<string, unknown>> = [{ type: 'thinking', thinking: reasoning, signature: sig }];
        const rawCalls0 = (m as { tool_calls?: unknown }).tool_calls;
        const calls0 = Array.isArray(rawCalls0) ? rawCalls0 : [];
        const blocks = [...thinkBlocks];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of calls0 as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
          blocks.push({ type: 'tool_use', id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), input: safeParseJson(tc.function?.arguments) });
        }
        out.push({ role: 'assistant', content: blocks });
        continue;
      }
    }

    const rawCalls = (m as { tool_calls?: unknown }).tool_calls;
    const calls = Array.isArray(rawCalls) ? rawCalls : [];
    if (calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
        blocks.push({ type: 'tool_use', id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), input: safeParseJson(tc.function?.arguments) });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages: out };
}

/** 工具规格（OpenAI function 嵌套）→ Anthropic 扁平形态 */
export function toAnthropicTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => {
    const spec = t as { type?: string; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    if (spec.type === 'function' && spec.function) {
      return {
        name: String(spec.function.name ?? ''),
        ...(spec.function.description ? { description: String(spec.function.description) } : {}),
        ...(spec.function.parameters ? { input_schema: spec.function.parameters } : {}),
      };
    }
    return t; // 已是扁平/未知形态原样透传
  });
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Anthropic SSE 事件 → 中性分片（有状态映射器）。input_json_delta 的
 * index 归属：Anthropic 事件带顶层 index（content block 序号）——映射器
 * 维护 block index → tool index 的指派（content_block_start 时登记）。
 */
export function createAnthropicChunkMapper(): (json: unknown) => AnthropicChunk | null {
  const toolIndexByBlock = new Map<number, number>();
  let tcCount = 0;
  const thinkingBlocks = new Map<number, { sig?: string }>();

  return (json) => {
    const e = (json ?? {}) as {
      type?: string; index?: unknown; delta?: unknown; content_block?: { signature?: unknown;
        type?: string; id?: unknown; name?: unknown;
      }; message?: { stop_reason?: unknown; usage?: unknown }; usage?: unknown;
    };
    const blockIndex = typeof e.index === 'number' ? e.index : -1;
    switch (e.type) {
      case 'content_block_start': {
        const block = e.content_block;
        if (block?.type === 'thinking') thinkingBlocks.set(blockIndex, {});

        if (block?.type === 'tool_use') {
          const index = tcCount++;
          toolIndexByBlock.set(blockIndex, index);
          return { delta: '', toolCalls: [{ index, id: String(block.id ?? ''), name: String(block.name ?? ''), argumentsDelta: '' }] };
        }
        return null;
      }
      case 'content_block_delta': {
        const d = e.delta as { type?: string; text?: unknown; partial_json?: unknown; thinking?: unknown } | undefined;
        if (d?.type === 'text_delta') return { delta: String(d.text ?? '') };
        if (d?.type === 'input_json_delta') {
          const index = toolIndexByBlock.get(blockIndex) ?? 0;
          return { delta: '', toolCalls: [{ index, argumentsDelta: String(d.partial_json ?? '') }] };
        }
        if (d?.type === 'thinking_delta') return { delta: '', reasoning: String(d.thinking ?? '') };
        return null;
      }
      case 'message_start': {
        // message_start 的 message.usage 携带输入侧计数——先透传（total
        // 与 finish 留给 message_delta 补齐）
        const usage = mapAnthropicUsage(e.message?.usage);
        return usage !== undefined ? { delta: '', usage } : null;
      }
      case 'message_delta': {
        // 真实线格式：stop_reason 在事件顶层 delta 子对象、usage 在事件
        // 顶层（官方 SDK 事件形态）；兼容 message.stop_reason 旧读法
        const d = e.delta as { stop_reason?: unknown } | undefined;
        const finish = mapFinishReason((d?.stop_reason ?? e.message?.stop_reason) as string | undefined);
        const usage = mapAnthropicUsage(e.usage ?? e.message?.usage);
        if (finish === undefined && usage === undefined) return null;
        return { delta: '', ...(finish !== undefined ? { finish } : {}), ...(usage !== undefined ? { usage } : {}) };
      }
      case 'error': {
        throw new Error('Anthropic SSE error 事件: ' + JSON.stringify(e).slice(0, 300));
      }
      case 'content_block_stop': {
        if (!thinkingBlocks.has(blockIndex)) return null;
        const sig = (e.content_block as { signature?: unknown } | undefined)?.signature;
        thinkingBlocks.delete(blockIndex);
        if (typeof sig !== 'string' || sig === '') return null;
        return { delta: '', thinkingSignature: sig };
      }

      default:
        return null; // ping / content_block_stop / message_stop 等无载荷事件
    }
  };
}

/** HTTP 错误响应 → LlmHttpError（读 body 文案 + Retry-After 头；cr-98） */
async function httpError(response: Response): Promise<LlmHttpError> {
  const text = await response.text().catch(() => '');
  return new LlmHttpError(response.status, `LLM HTTP ${response.status}: ${text.slice(0, 500)}`, parseRetryAfter(response.headers.get('retry-after')));
}

export class AnthropicCompletions {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly defaultModel?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: AnthropicOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(params: AnthropicRequest): AsyncGenerator<AnthropicChunk, void, void> {
    if (this.closed) throw new Error('AnthropicCompletions 已 close');
    const model = params.model ?? this.defaultModel;
    if (!model) throw new Error('model 未指定（params.model 或构造参数 defaultModel）');
    const { signal, api_key, provider: _provider, headers: extraHeaders, ...restParams } = params;
    const restStripped = stripTransportKeys(restParams as Record<string, unknown>);
    const authKey = api_key || this.apiKey;
    const { max_tokens, temperature, top_p, stop, tools, messages, ...rest } = restStripped as Record<string, unknown>;
    const mapped = toAnthropicMessages(messages as AnthropicMessage[]);
    const body: Record<string, unknown> = {
      model,
      max_tokens: typeof max_tokens === 'number' ? max_tokens : 4096,
      stream: true,
      ...rest,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(top_p !== undefined ? { top_p } : {}),
      ...(stop !== undefined ? { stop_sequences: Array.isArray(stop) ? stop : [stop] } : {}),
      ...(mapped.system !== undefined ? { system: mapped.system } : {}),
      messages: mapped.messages,
    };
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools !== undefined) body.tools = anthropicTools;
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
      const response = await this.fetchImpl(this.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': authKey ?? '',
          'anthropic-version': ANTHROPIC_VERSION,
          ...this.headers,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw await httpError(response);
      if (!response.body) throw new Error('LLM 响应缺少 body');
      armProgressTimeout();
      const mapEvent = createAnthropicChunkMapper();
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
   * GET /v1/models 模型发现（Anthropic 原生清单端点；部分账号需在端点
   * 设置中显式启用）。返回模型 id 清单（字典序）。
   */
  async listModels(params: { api_key?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string[]> {
    if (this.closed) throw new Error('AnthropicCompletions 已 close');
    const authKey = params.api_key || this.apiKey;
    const response = await this.fetchImpl(this.baseUrl + '/v1/models?limit=1000', {
      headers: {
        'x-api-key': authKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
        ...this.headers,
        ...params.headers,
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) throw await httpError(response);
    const json = (await response.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) throw new Error('LLM /v1/models 响应缺少 data 数组（非 Anthropic 端点）');
    return json.data
      .map((m) => String((m as { id?: unknown }).id ?? ''))
      .filter(Boolean)
      .sort();
  }

  /** stream 的聚合语法糖（同 openai 库 chat 形态） */
  async chat(params: AnthropicRequest): Promise<AnthropicChatResult> {
    const model = params.model ?? this.defaultModel ?? '';
    let text = '';
    let reasoning = '';
    let finish: string | undefined;
    let usage: AnthropicUsage | undefined;
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