// ============================================================
// ac-openai-completions —— OpenAI 兼容 chat completions 纯库
//
// 【定位（2026-09-05 边界评估明示）】共享协议实现库，**不是 provider/
// 插件行**：本包不注册任何 ctx.llm provider、无 cordis 依赖、不出现在
// cordis.yml——provider 注册唯一入口是 ac-llm-pool（配置驱动
// llmProviders 池）。请勿把本包当 provider 适配行引用；新增 OpenAI
// 兼容连接 = 在 config 加池条目，不是写新行。
//
// 零 cordis 依赖、构造零 I/O（懒连接由路由器触发首次调用时发生）。
// openai / deepseek / glm 三个适配器薄行与 ac-llm-pool 共用本库；
// 返回形状与 ac-llm（LLM 域契约 owning package）的 LlmProvider
// 结构化兼容——工厂零胶水直接返回实例。
// ============================================================

export interface CompletionsOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  /**
   * 无进展超时毫秒（缺省 180000；≤0 禁用）。建连、响应头、每条 SSE
   * data 事件都会刷新计时器——活跃长生成不限总时长（旧版一刀切总时长
   * 会错杀慢模型长输出）；但代理滴流 keep-alive 字节/SSE 注释行不算
   * 进展（C3：半开连接在窗口内必被中止，run 永不因死流挂死）。
   * 与调用方 signal 并集（任一先中止即中止）。
   */
  timeoutMs?: number;
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch;
  /**
   * 视觉模型清单（精确匹配 > 前缀 `m-`/`m/` > 通配 `*`）：命中才把
   * user 消息的 attachments 物化为多模态 content 块（image_url /
   * video_url / file）；未命中/未配置一律剥离 attachments（纯文本路径
   * ——非视觉模型收到媒体块会 400，fail-closed 剥离保证不回归）。
   * 共享一条连接混跑文本/视觉模型时按清单分流；整条连接都是视觉模型
   * 可用 `['*']`。
   */
  visionModels?: string[];
  /**
   * 媒体引用物化器（workspace 相对路径 → data: base64 URL 等）。
   * http(s) 引用不经此直传；未注入/返回 undefined/抛错 → 该附件降级为
   * 文本占位块（不炸整轮请求）。
   */
  resolveMedia?: (ref: string, signal?: AbortSignal) => Promise<string | undefined>;
}

/**
 * 多模态附件引用（结构化兼容 ac-llm 的 LlmAttachment——纯库零依赖，
 * 形状本地声明）：ref = http(s) URL 直传；其余（workspace 相对路径）
 * 经 resolveMedia 物化为 data: base64 URL。kind 分发（M4）：
 * image → image_url 块；video → video_url 块（GLM；仅 URL）；
 * file → file 块（GLM {file_url|file_data, filename}）。
 */
export interface CompletionsAttachment {
  kind: 'image' | 'video' | 'file';
  ref: string;
  mime?: string;
  filename?: string;
  detail?: string;
}

/** OpenAI 兼容多模态 content 块（attachments 物化后的请求体形态） */
export interface CompletionsContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
  video_url?: { url: string };
  file?: { file_url?: string; file_data?: string; filename?: string };
  [key: string]: unknown;
}

export interface CompletionsMessage {
  role: string;
  content: string | CompletionsContentPart[];
  /** 传输层键：构造请求体前物化/剥离，绝不进 body */
  attachments?: CompletionsAttachment[];
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
const DEFAULT_TIMEOUT_MS = 180_000;
/** 单条消息附件上限（与 web-api deliver 入口校验对齐；超出部分降级为溢出行） */
const MAX_ATTACHMENTS_PER_MESSAGE = 50;
/**
 * 视觉能力探测图（1×1 PNG data URL）：与真图同一物化路径（base64
 * image_url 块）——探测结论即"本管线能否给它发图"。注：GLM-4V-Flash
 * 这类"仅 URL"模型会 400 → 判非视觉（对本管线的 workspace 物化确实如此）。
 */
const PROBE_IMAGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 模型名 × 模式清单匹配（视觉门控单源）：精确 > 前缀 `m-`/`m/`（与
 * llm 路由同款）> 通配 `'*'`。空清单/未定义 = 恒 false。
 * 导出供 ac-llm 服务查询口复用（系统提示词模型能力注入等消费面与
 * 适配层门控同一判定，防两处漂移）。
 */
export function modelMatchesPatterns(model: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  if (patterns.includes(model) || patterns.includes('*')) return true;
  return patterns.some((m) => model.startsWith(`${m}-`) || model.startsWith(`${m}/`));
}

export class OpenAICompletions {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly defaultModel?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly visionModels: string[] | undefined;
  private readonly resolveMediaImpl: CompletionsOptions['resolveMedia'];
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: CompletionsOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.visionModels = options.visionModels;
    this.resolveMediaImpl = options.resolveMedia;
  }

  async *stream(params: CompletionsRequest): AsyncGenerator<CompletionsChunk, void, void> {
    if (this.closed) throw new Error('OpenAICompletions 已 close');
    const model = params.model ?? this.defaultModel;
    if (!model) throw new Error('model 未指定（params.model 或构造参数 defaultModel）');

    // api_key 是传输层键（单次调用覆盖构造默认）：剥离后才进 body
    const { signal, api_key, ...bodyParams } = params;
    const authKey = api_key || this.apiKey;
    // attachments 是传输层键（同 api_key 纪律）：构造请求体前物化/剥离
    const messages = await this.materializeMessages(model, params.messages, signal);
    const controller = new AbortController();
    this.controllers.add(controller);
    // 调用方中止透传（reason 原样——用户中止文案可诊断）。addEventListener
    // 不补发已触发事件：调用前已中止的 signal 立即生效
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    // 无进展超时（C3）：建连 → 响应头 → 每条 SSE data 事件各刷新一次计时器。
    // 只认 data 事件（sseDataEvents 只 yield data 行）——滴流 keep-alive 字节/
    // 注释行不续命，半开连接在窗口内必被中止；活跃流不限总时长。timer
    // unref 不保活事件循环（对齐旧 AbortSignal.timeout 内建 unref 语义）。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armProgressTimeout = () => {
      if (this.timeoutMs <= 0) return;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          controller.abort(
            new Error(`LLM 响应超时（${Math.round(this.timeoutMs / 1000)}s 无进展：建连、响应头或流式数据）`),
          ),
        this.timeoutMs,
      );
      timer.unref();
    };
    try {
      armProgressTimeout();
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
          messages,
          model,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      if (!response.body) throw new Error('LLM 响应缺少 body');
      armProgressTimeout(); // 响应头到达 = 进展（刷新至流静默窗口）
      for await (const data of sseDataEvents(response.body)) {
        armProgressTimeout(); // data 事件 = 进展（注释行不 yield、不刷新）
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
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  /**
   * attachments 物化/剥离（传输边界，构造请求体前的唯一变换）：
   *   · 无任何 attachments → 原样返回（既有请求体字节不变）；
   *   · 视觉模型（visionModels 命中）+ user 消息 → content 物化为块数组，
   *     按 kind 分发：image → image_url（http 直传 / resolveMedia → data:）
   *     ；video → video_url（仅 http——视频过大不做 base64）；file →
   *     file 块（http → file_url；workspace → resolveMedia → file_data）。
   *     物化失败降级文本占位块（单附件缺失不炸整轮请求）；单条消息超出
   *     50 个附件的部分降级为溢出行（与 deliver 入口上限对齐）；
   *   · 非视觉模型 / 非 user 角色 → 剥离 attachments 保留原 content
   *     （DeepSeek/GLM 的非视觉模型收到媒体块即 400；图片仅 user 位合法）。
   * attachments 键本身永不进 body（GLM 消息对象 additionalProperties:false）。
   */
  private async materializeMessages(
    model: string | undefined,
    messages: CompletionsMessage[],
    signal?: AbortSignal,
  ): Promise<CompletionsMessage[]> {
    if (!messages.some((m) => Array.isArray(m.attachments) && m.attachments.length > 0)) {
      return messages;
    }
    const vision = model !== undefined && this.modelAcceptsImages(model);
    const out: CompletionsMessage[] = [];
    for (const m of messages) {
      const { attachments: _attachments, ...rest } = m;
      const atts = (Array.isArray(_attachments) ? _attachments : []).filter(
        (a) =>
          a &&
          (a.kind === 'image' || a.kind === 'video' || a.kind === 'file') &&
          typeof a.ref === 'string' &&
          a.ref !== '',
      );
      if (atts.length === 0 || !vision || m.role !== 'user') {
        out.push(rest); // 剥离路径：content 原样（[附件] 路径文本行兜底）
        continue;
      }
      const overflow = atts.length > MAX_ATTACHMENTS_PER_MESSAGE ? atts.length - MAX_ATTACHMENTS_PER_MESSAGE : 0;
      const blocks: CompletionsContentPart[] = [];
      if (typeof rest.content === 'string' && rest.content !== '') {
        blocks.push({ type: 'text', text: rest.content });
      }
      for (const a of atts.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
        blocks.push(await this.materializeAttachment(a, signal));
      }
      if (overflow > 0) {
        blocks.push({ type: 'text', text: `[其余 ${overflow} 个附件未发送（超出单条 ${MAX_ATTACHMENTS_PER_MESSAGE} 上限）]` });
      }
      out.push(blocks.length > 0 ? { ...rest, content: blocks } : rest);
    }
    return out;
  }

  /** 单附件物化（失败 → 降级文本占位块，不炸整轮请求） */
  private async materializeAttachment(
    a: CompletionsAttachment,
    signal?: AbortSignal,
  ): Promise<CompletionsContentPart> {
    const isHttp = /^https?:\/\//i.test(a.ref);
    if (a.kind === 'image') {
      const url = isHttp ? a.ref : await this.resolveMediaRef(a.ref, signal);
      return url !== undefined
        ? { type: 'image_url', image_url: { url, ...(a.detail ? { detail: a.detail } : {}) } }
        : { type: 'text', text: `[图片无法加载: ${a.filename ?? a.ref}]` };
    }
    if (a.kind === 'video') {
      // GLM video_url 仅收 URL（≤200M 的 mp4/mkv/mov）；workspace 引用
      // 不做 base64（体积不可行）——降级占位
      return isHttp
        ? { type: 'video_url', video_url: { url: a.ref } }
        : { type: 'text', text: `[视频仅支持 URL 引用: ${a.filename ?? a.ref}]` };
    }
    // file：http → file_url；workspace → resolveMedia 物化 file_data（GLM 形状）
    if (isHttp) {
      return { type: 'file', file: { file_url: a.ref, ...(a.filename ? { filename: a.filename } : {}) } };
    }
    const data = await this.resolveMediaRef(a.ref, signal);
    return data !== undefined
      ? { type: 'file', file: { file_data: data, ...(a.filename ? { filename: a.filename } : {}) } }
      : { type: 'text', text: `[文件无法加载: ${a.filename ?? a.ref}]` };
  }

  /** 媒体引用解析（未注入/抛错 → undefined = 降级占位） */
  private async resolveMediaRef(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.resolveMediaImpl === undefined) return undefined;
    try {
      return await this.resolveMediaImpl(ref, signal);
    } catch {
      return undefined;
    }
  }

  /** 视觉模型判定：精确 > 前缀（m- / m/，与 llm 路由同款）> 通配 '*' */
  private modelAcceptsImages(model: string): boolean {
    return modelMatchesPatterns(model, this.visionModels);
  }

  /**
   * GET /models 模型发现（OpenAI 兼容清单端点）。
   * api_key 为传输层键（单次覆盖构造默认，同 stream 语义）；返回模型 id
   * 清单（字典序——确定性缓存写入）。响应形状 { data: [{ id }] }；
   * 缺 data 数组 → 抛错（非 OpenAI 兼容面可诊断）。
   */  async listModels(params: { api_key?: string; signal?: AbortSignal } = {}): Promise<string[]> {
    if (this.closed) throw new Error('OpenAICompletions 已 close');
    const authKey = params.api_key || this.apiKey;
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: {
        ...(authKey ? { authorization: `Bearer ${authKey}` } : {}),
        ...this.headers,
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const json = (await response.json()) as { data?: unknown };
    if (!Array.isArray(json?.data)) throw new Error('LLM /models 响应缺少 data 数组（非 OpenAI 兼容端点）');
    return json.data
      .map((m) => String((m as { id?: unknown })?.id ?? ''))
      .filter(Boolean)
      .sort();
  }

  /**
   * 视觉能力探测（模型能力元数据）：向模型发一条非流式最小请求
   * （1×1 PNG image_url 块 + "1"，max_tokens=1），按 HTTP 状态三态判定：
   *   · 2xx → true（收图，多模态）
   *   · 400 → false（拒绝图片块——文本模型；"仅 URL"的视觉模型同判，
   *     对本管线的 base64 物化路径而言结论成立）
   *   · 401/403/429/5xx/网络异常 → undefined（未知——凭据错/限流/服务端
   *     故障不可归因于"不支持图片"，fail-closed 不猜）
   * 成本：≤1 输出 token + 单图 token（DeepSeek 上限 384）。不抛错——
   * 结论含 undefined 本身是有效载荷。
   */
  async probeVision(
    model: string,
    params: { api_key?: string; signal?: AbortSignal } = {},
  ): Promise<boolean | undefined> {
    if (this.closed) throw new Error('OpenAICompletions 已 close');
    const authKey = params.api_key || this.apiKey;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authKey ? { authorization: `Bearer ${authKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: PROBE_IMAGE_URL } },
                { type: 'text', text: '1' },
              ],
            },
          ],
        }),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (response.ok) return true;
      if (response.status === 400) return false;
      return undefined; // 其他状态 = 未知（不猜）
    } catch {
      return undefined; // 网络/中止异常 = 未知
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
      // 空冲洗片（id/name/arguments 全空）丢弃：聚合器见 index 即建条目，
      // 放行会产出 id/name 双空的幻影调用 → loop 执行 "unknown tool:" 并
      // 落一条无结果的工具卡（2026-09-04 双工具卡反馈的幻影源）
      if (frag.id === undefined && frag.name === undefined && frag.argumentsDelta === undefined) continue;
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
