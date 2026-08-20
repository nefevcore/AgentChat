// ============================================================
// src/core/llm/openai.ts —— OpenAI 兼容的 LLM 适配器
//
// 支持 OpenAI / DeepSeek / Ollama 等兼容 API。
// 支持流式输出 (Server-Sent Events)。
// 使用原生 fetch 发送 HTTP 请求，确保 JSON 字段完全可控。
//
// 铁律：零外部依赖（fetch / TextDecoder / ReadableStream 为 Node 18+ 内置）。
//       仅引用 ../types ../logger ./base ./chat-stream。
//       唯一例外：undici（Node 内置 fetch 的同源实现包，2026-08-17 引入）——
//       全局 fetch 无法配置连接池（keepAlive/bodyTimeout），深度思考模型
//       （GLM-5.3 max 档）流式 chunk 间隔可达数分钟，默认 300s bodyTimeout
//       会被误杀（UND_ERR_BODY_TIMEOUT）；keep-alive 复用竞态也是
//       ECONNRESET 的主要来源之一。故引入 undici 的 fetch + Agent 显式管控。
// ============================================================

import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { LLMRequest, LLMResponse, LLMUsage } from '@agentchat/llm';
import type { LLMRequestMessage, ToolCall } from '@agentchat/types';
import { BaseLLM, ChatStream } from '@agentchat/llm';
import { createLogger } from '@agentchat/util';

const log = createLogger('[OpenAIChatLLM]');

/**
 * LLM 请求整体超时（毫秒）。防网络/服务端挂起导致 loop 永久卡住、
 * runningMap 残留（后续 trigger 只注入 steer、无推理）。
 * 深度思考模型可能较慢，取 180s 兜底；外部 abort 仍即时生效。
 * 仅覆盖到响应头到达（SSE 阶段由 dispatcher.bodyTimeout 接管）。
 */
const LLM_REQUEST_TIMEOUT_MS = 180_000;

/**
 * 瞬时失败自动重试上限与退避基数（2026-08-17 网络专项）：
 * ECONNRESET / 连接超时 / 5xx / 限流等瞬时错误，在"零输出失败"
 * （未流出任何 thinking/content/toolcall 事件）时整段重试，
 * 指数退避 800ms * 2^n + 抖动。历史数据（8/17 GLM 首晚 5 次失败）
 * 全部为瞬态，重试即愈；已有部分输出的失败不重试（落盘 partial）。
 */
const LLM_MAX_RETRIES = 3;
const LLM_RETRY_BASE_MS = 800;

/**
 * LLM 专用连接池（模块级共享，所有 provider 实例复用）：
 *   - keepAliveTimeout 钉死 1s：把"复用已被服务端关闭连接"的竞态窗口
 *     压到最小（定时任务为低频负载，重新握手成本可忽略）
 *   - bodyTimeout 600s：深度思考模型（GLM-5.3 强制思考）chunk 间静默
 *     可达数分钟，默认 300s 会误杀为 UND_ERR_BODY_TIMEOUT
 *   - headersTimeout 300s > 外层 180s 请求超时，外层先兜
 */
const LLM_DISPATCHER = new UndiciAgent({
  connections: 128,
  keepAliveTimeout: 1_000,
  keepAliveMaxTimeout: 1_000,
  pipelining: 1,
  headersTimeout: 300_000,
  bodyTimeout: 600_000,
  connect: { timeout: 15_000 },
});

/** 可重试的网络层错误码（连接重置/超时/DNS 抖动/undici 内部瞬时错误） */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/** 可重试的 HTTP 状态码（429 限流排除余额类、5xx 过载/网关、408 超时） */
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * 判断流式调用失败是否可重试（瞬时错误）。
 * 不可重试：外部中止、余额不足 429、4xx 参数/鉴权错误、已流出部分内容。
 */
function isRetryableStreamError(err: any): boolean {
  if (err?.__noRetry) return false;        // 显式标记（外部中止等）
  if (err?.__retry) return true;           // 显式标记（连通性预检的网络类失败）
  const code = err?.cause?.code ?? err?.code ?? '';
  if (RETRYABLE_NET_CODES.has(code)) return true;
  // undici 流中断（TypeError: terminated）部分场景 cause 无 code
  if (err?.message === 'terminated') return true;
  const status = err?.__httpStatus;
  if (status !== undefined) {
    if (status === 429) return !err?.__fatal429;  // 智谱 1113 余额不足重试无意义
    return RETRYABLE_HTTP_STATUS.has(status);
  }
  return false;
}

/** 可被外部 abort 打断的退避等待（重试间隔内用户中止立即生效） */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface OpenAIChatConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** 温度参数 (0-2)，控制输出随机性，null 则不传 */
  temperature?: number | null;
  /** 最大输出 token，null/0/undefined 则不传 */
  maxTokens?: number | null;
  /**
   * 核采样参数 (0-1)，模型考虑前 top_p 概率的 token。
   * null 则不传。建议与 temperature 二选一调整。
   */
  topP?: number | null;
  /**
   * 输出格式。"json_object" 强制 JSON，"text" 使用默认。
   * null 则不传。
   */
  responseFormat?: 'text' | 'json_object' | null;
  /**
   * 停止词。最多 16 个，可为单个字符串或数组。
   * null 则不传。
   */
  stop?: string | string[] | null;
}

/** 将值转为 number，空字符串视为 undefined */
function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export class OpenAIChatLLM extends BaseLLM {

  // ======== 字段 ========

  protected apiKey: string;
  protected baseURL: string;
  protected temperature: number | undefined;
  protected maxTokens: number | undefined;
  protected topP: number | undefined;
  protected responseFormat: 'text' | 'json_object' | undefined;
  protected stop: string | string[] | undefined;
  /** 日志前缀，子类可覆盖 */
  protected logPrefix: string = '[OpenAIChatLLM]';

  // ======== 构造 & 配置 ========

  constructor(config: OpenAIChatConfig) {
    super(config.model ?? 'gpt-4o');
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com/v1';
    this.temperature = toNum(config.temperature);
    const mt = config.maxTokens ?? 0;
    this.maxTokens = (mt && mt > 0) ? mt : undefined;
    this.topP = (config.topP != null) ? config.topP : undefined;
    this.responseFormat = config.responseFormat ?? undefined;
    this.stop = config.stop ?? undefined;
  }

  /** 运行时更新 API Key（前端保存后同步到内存中的 LLM 实例） */
  updateApiKey(key: string): void {
    this.apiKey = key;
    log.info(`${this.logPrefix} API Key 已更新`);
  }

  // ======== 公共 API ========

  /** 非流式调用 —— stream().result() 的语法糖 */
  async chat(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    return this.stream(req, signal).result();
  }

  /** 流式调用 —— 返回 ChatStream（AsyncIterable + .result()） */
  stream(req: LLMRequest, signal?: AbortSignal): ChatStream {
    const cs = new ChatStream();
    this._runStream(req, signal, cs).catch(err => {
      log.error(`${this.logPrefix} 流式未捕获错误：`, err);
      cs.error(
        { content: null, toolCalls: [], finishReason: 'error' },
        `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return cs;
  }

  // ======== 流式管道 ========

  /**
   * 核心流式管道（外层：瞬时失败自动重试）：
   *   1. 连通性预检（3s 快速失败）
   *   2. POST chat/completions
   *   3. 逐行解析 SSE → 发射 thinking / message / toolcall 事件
   *   4. 完成或出错时通知 ChatStream
   *
   * 重试策略（2026-08-17 网络专项）：连接重置/超时/5xx/限流等瞬时错误，
   * 且失败时尚未流出任何内容（零输出失败）时，指数退避后整段重试——
   * 单次瞬时失败对调用方不可见；已有部分输出则不重试，partial 随错误落盘。
   */
  private async _runStream(req: LLMRequest, signal: AbortSignal | undefined, cs: ChatStream): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this._attemptStream(req, signal, cs);
        return; // 正常完成 / attempt 内已终态（done 或外部中止 error）
      } catch (err: any) {
        const partial: { content: string; reasoning: string; usage?: LLMUsage } =
          err?.__partial ?? { content: '', reasoning: '' };
        // 外部中止（chat.interrupt / 优雅关闭）：立即终态，不重试
        if (signal?.aborted) {
          cs.error({ content: partial.content || null, toolCalls: [], finishReason: 'error', reasoning: partial.reasoning || undefined, usage: partial.usage }, '请求已被中止');
          return;
        }
        const retryable = err?.__clean === true && isRetryableStreamError(err);
        if (retryable && attempt < LLM_MAX_RETRIES) {
          const delay = LLM_RETRY_BASE_MS * 2 ** attempt + Math.random() * 400;
          const why = err?.__httpStatus ?? err?.cause?.code ?? err?.code ?? err?.message;
          log.warn(`${this.logPrefix} 第 ${attempt + 1} 次尝试失败（${why}），${Math.round(delay)}ms 后自动重试（${attempt + 1}/${LLM_MAX_RETRIES}）[→ ${this.baseURL}]`);
          await abortableDelay(delay, signal);
          if (signal?.aborted) {
            cs.error({ content: partial.content || null, toolCalls: [], finishReason: 'error', reasoning: partial.reasoning || undefined, usage: partial.usage }, '请求已被中止');
            return;
          }
          continue;
        }
        // ---- 终态失败 ----
        if (err?.name === 'AbortError') {
          const msg = err?.__timedOut ? `LLM 请求超时（${LLM_REQUEST_TIMEOUT_MS / 1000}s）` : '请求已被中止';
          cs.error({ content: partial.content || null, toolCalls: [], finishReason: 'error', reasoning: partial.reasoning || undefined, usage: partial.usage }, msg);
          return;
        }
        const errCode = err?.cause?.code ?? err?.code ?? '';
        const suffix = errCode ? ` (${errCode})` : '';
        const retried = attempt > 0 ? `（已自动重试 ${attempt} 次）` : '';
        const errMsg = `LLM 流式调用失败：${err.message}${suffix}${retried}`;
        log.error(`Stream 错误：${err.message}${suffix}${retried} [→ ${this.baseURL}/chat/completions]`);
        cs.error({ content: partial.content || null, toolCalls: [], finishReason: 'error', reasoning: partial.reasoning || undefined, usage: partial.usage }, errMsg);
        return;
      }
    }
  }

  /**
   * 单次流式尝试（内层）：预检 → POST → SSE 解析 → 通知 ChatStream。
   * 失败时抛给 _runStream 决定重试或终态；抛出的 err 携带分类标记：
   *   __clean   是否零输出失败（未流出任何 thinking/content/toolcall）
   *   __partial 失败时的已收内容（终态落盘 partial 用）
   *   __timedOut（180s 响应头超时）/ __httpStatus / __fatal429 / __noRetry
   */
  private async _attemptStream(req: LLMRequest, signal: AbortSignal | undefined, cs: ChatStream): Promise<void> {
    let usage: LLMUsage | undefined;
    let fullContent = '';
    let fullReasoning = '';
    // 工具调用累加器（catch 中零输出判定需要，故声明在 try 外）
    const tcAcc = new Map<number, { id: string; name: string; arguments: string }>();
    // 外部中断（chat.interrupt / 优雅关闭）：abort 时主动 cancel SSE 流，解除挂起的 reader.read()
    const onAbort = () => { try { void reader?.cancel()?.catch(() => {}); } catch { /* ignore */ } };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // 内部超时控制器（合并外部 signal + 整体超时；防服务端挂起 → loop 卡死、runningMap 残留）
    const reqController = new AbortController();
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let onExternalAbort: (() => void) | undefined;

    try {
      // ---- 1. 连通性预检 ----
      await this._probeConnectivity(signal);

      // ---- 2. 发送请求 ----
      const body = this.buildRequestBody(req, true);
      let bodyStr = JSON.stringify(body);
      // 纵深防御：清洗 lone surrogate（JSON 文本级）。
      // 某些路径（如 query_history 截断）可能让消息 content 携带孤立代理项，
      // JSON.stringify 会输出 \ud83d 转义，DeepSeek 解析时报 400 "lone leading surrogate"。
      bodyStr = bodyStr.replace(/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/g, '\\ufffd')
        .replace(/(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g, '\\ufffd');
      // 请求体 JSON 文本后处理（子类可覆写，如 DeepSeek 规避 \x 解析 bug）
      onExternalAbort = () => reqController.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        reqController.abort(new Error('LLM 请求超时'));
      }, LLM_REQUEST_TIMEOUT_MS);
      const res = await undiciFetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: this.postProcessBodyJson(bodyStr),
        signal: reqController.signal,
        dispatcher: LLM_DISPATCHER,
      });
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      if (onExternalAbort) signal?.removeEventListener('abort', onExternalAbort);

      if (!res.ok) {
        const errText = await res.text();
        const httpErr = new Error(`${res.status} ${errText}`);
        (httpErr as any).__httpStatus = res.status;
        // 智谱/DeepSeek 余额类 429（code 1113「余额不足或无可用资源包」）重试无意义
        if (res.status === 429 && /1113|余额不足|insufficient/i.test(errText)) {
          (httpErr as any).__fatal429 = true;
        }
        throw httpErr;
      }

      // ---- 3. 解析 SSE 流 ----
      reader = res.body!.getReader();
      reqController.signal.addEventListener('abort', onAbort, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      let thinkingStarted = false;
      let messageStarted = false;
      // SSE 完整性：连接关闭（read done）但未收到 [DONE] 终止符 = 流被截断，
      // 半截内容不得冒充完整回复（2026-08-17 网络专项补充）
      let sawDoneMarker = false;
      const partial = () => ({ content: fullContent, reasoning: fullReasoning });

      while (true) {
        // 中断（chat.interrupt / 优雅关闭 / 请求超时）：立即停止 SSE 流
        if (reqController.signal.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          cs.push({ type: 'error', partial: partial(), error: timedOut ? '请求超时' : '已中断' });
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') { sawDoneMarker = true; continue; }

          try {
            const chunk = JSON.parse(data);
            if (chunk.usage) usage = extractUsage(chunk.usage);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // --- thinking ---
            if (delta.reasoning_content) {
              if (!thinkingStarted) { cs.push({ type: 'thinking_start', partial: partial() }); thinkingStarted = true; }
              fullReasoning += delta.reasoning_content;
              cs.push({ type: 'thinking_update', delta: delta.reasoning_content, partial: partial() });
            }
            // --- content ---
            if (delta.content) {
              if (thinkingStarted) { cs.push({ type: 'thinking_end', partial: partial() }); thinkingStarted = false; }
              if (!messageStarted) { cs.push({ type: 'message_start', partial: partial() }); messageStarted = true; }
              fullContent += delta.content;
              cs.push({ type: 'message_update', delta: delta.content, partial: partial() });
            }
            // --- tool calls ---
            if (delta.tool_calls) {
              if (thinkingStarted) { cs.push({ type: 'thinking_end', partial: partial() }); thinkingStarted = false; }
              if (messageStarted) { cs.push({ type: 'message_end', partial: partial() }); messageStarted = false; }
              for (const tc of delta.tool_calls) {
                const existing = tcAcc.get(tc.index);
                if (!existing) {
                  const fallbackId = `call_idx_${tc.index}`;
                  tcAcc.set(tc.index, { id: tc.id || fallbackId, name: tc.function?.name ?? '', arguments: '' });
                  cs.push({ type: 'toolcall_start', partial: partial(), toolCall: { index: tc.index, id: tc.id || fallbackId, name: tc.function?.name, arguments: '' } });
                }
                const acc = tcAcc.get(tc.index)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                  acc.arguments += tc.function.arguments;
                  cs.push({ type: 'toolcall_update', delta: tc.function.arguments, partial: partial(), toolCall: { index: tc.index, name: acc.name, arguments: acc.arguments } });
                }
              }
            }
          } catch (err: any) {
            // 损坏分片不再静默：tool_call 增量若随损坏分片丢失，流仍会以 [DONE]
            // 干净终止（8/19 agent_chat_dev 案例：思考/正文完整、tool_calls 整体
            // 缺失、无 error 落盘——半截回复冒充完稿）。至少留下日志锚点。
            log.warn(`SSE 分片解析失败（可能截断）：${String(data).slice(0, 120)}`);
            void err;
          }
        }
      }

      // ---- 3.5 流完整性校验：连接正常关闭（read done）但未见 [DONE] = 截断 ----
      // 部分中间设备/网关以 FIN 优雅关闭掐断长连接，undici 表现为 done=true 而非异常，
      // 半截内容若按完整收尾会静默产出截断回复。零输出关闭可整段重试；已有内容
      // 则按错误落盘 partial（与 terminated 路径同类别，上层 continue_turn 兜底）。
      if (!sawDoneMarker) {
        const truncated = new Error('LLM 流不完整：连接已关闭但未收到 [DONE] 终止符（内容可能被截断）');
        (truncated as any).__retry = fullContent === '' && fullReasoning === '' && tcAcc.size === 0;
        throw truncated;
      }

      // ---- 4. 收尾 ----
      if (timeoutTimer) clearTimeout(timeoutTimer);
      reqController.signal.removeEventListener('abort', onAbort);
      if (onExternalAbort) signal?.removeEventListener('abort', onExternalAbort);
      if (thinkingStarted) cs.push({ type: 'thinking_end', partial: partial() });
      // 兜底恢复（2026-08-10）：content 空但 reasoning 非空且无工具调用 → 提升 reasoning 为 content，
      // 防 DeepSeek 思考模式把最终回答留在 reasoning_content、content 返回空导致回复丢失
      if (!fullContent && fullReasoning && tcAcc.size === 0) {
        fullContent = fullReasoning;
        fullReasoning = '';
        if (!messageStarted) { cs.push({ type: 'message_start', partial: partial() }); messageStarted = true; }
        cs.push({ type: 'message_update', delta: fullContent, partial: partial() });
        cs.push({ type: 'message_end', partial: partial() });
      } else if (messageStarted || tcAcc.size > 0) {
        cs.push({ type: 'message_end', partial: partial() });
      }
      for (const [index, acc] of tcAcc) {
        cs.push({ type: 'toolcall_end', partial: partial(), toolCall: { index, id: acc.id, name: acc.name, arguments: acc.arguments } });
      }

      // 反向归一化：LLM 原生消息 → Agent 消息（转换动作收拢在 provider 内，
      // OpenAI tool_calls.arguments 字符串 → 简化 ToolCall.arguments 对象）
      const apiAssistant: any = {
        role: 'assistant',
        content: fullContent || '',
        tool_calls: [...tcAcc.values()].map(a => ({ id: a.id, type: 'function', function: { name: a.name, arguments: a.arguments } })),
        reasoning_content: fullReasoning || undefined,
      };
      const [agentMsg] = this.fromProviderMessages([apiAssistant]);
      const toolCalls = (agentMsg.tool_calls as ToolCall[] | undefined) ?? [];
      cs.done({
        content: agentMsg.content || null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        reasoning: agentMsg.reasoning_content,
        usage,
      });
    } catch (err: any) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      reqController.signal.removeEventListener('abort', onAbort);
      if (onExternalAbort) signal?.removeEventListener('abort', onExternalAbort);
      // 附带分类标记后抛给 _runStream 决定重试或终态
      (err as any).__partial = { content: fullContent, reasoning: fullReasoning, usage };
      (err as any).__clean = fullContent === '' && fullReasoning === '' && tcAcc.size === 0;
      if (err?.name === 'AbortError') {
        if (signal?.aborted) { (err as any).__noRetry = true; throw err; }
        (err as any).__timedOut = timedOut; // 180s 响应头超时：瞬时过载，可重试
      }
      throw err;
    }
  }

  // ======== 连通性预检 ========

  /**
   * 向 baseURL 发送 GET /models 探测 API 可达性（不影响对话缓存）。
   * 超时 3 秒，网络错误转换为中文诊断信息。
   */
  private async _probeConnectivity(externalSignal?: AbortSignal): Promise<void> {
    const probeAbort = new AbortController();
    const probeTimer = setTimeout(() => probeAbort.abort(), 3000);
    const onExternalAbort = () => probeAbort.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    /** 网络类诊断错误（瞬时抖动居多）标记可重试；外部中止标记不可重试 */
    const diag = (msg: string, retry: boolean): Error => {
      const e = new Error(msg);
      (e as any)[retry ? '__retry' : '__noRetry'] = true;
      return e;
    };

    try {
      await undiciFetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: probeAbort.signal,
        dispatcher: LLM_DISPATCHER,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (externalSignal?.aborted) throw diag('请求已被中止', false);
        throw diag(`LLM 服务不可达：${this.baseURL}（连接超时，请检查网络/VPN/防火墙）`, true);
      }
      const errCode = err?.cause?.code ?? err?.code ?? '';
      if (errCode === 'ENOTFOUND' || errCode === 'EAI_AGAIN') throw diag(`LLM 服务 DNS 解析失败：${this.baseURL}（请检查网络/VPN）`, true);
      if (errCode === 'ECONNREFUSED') throw diag(`LLM 服务拒绝连接：${this.baseURL}（服务器可能未启动）`, true);
      if (errCode === 'EHOSTUNREACH' || errCode === 'ENETUNREACH') throw diag(`LLM 服务网络不可达：${this.baseURL}（VPN 可能未连接）`, true);
      throw diag(`LLM 服务不可达：${this.baseURL}（${err.message}）`, true);
    } finally {
      clearTimeout(probeTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ======== 请求构建（子类可覆写） ========

  /**
   * 正向转换：将请求消息（持久化格式或内存格式）转换为 OpenAI 兼容的 LLM API 消息。
   *
   * 职责：
   *   · 角色解析：支持持久化发言格式（role=agent，依据 viewer=当前视角 Agent ID 做视角
   *     转换：agent_id===viewer → assistant；agent_id≠viewer → user）+ 内存格式
   *     （user/assistant 已解析）；error → tool；持久化 event/旧 trigger 在读取层
   *     已归一化为 user + source，此处兜底按 user 处理
   *   · 工具调用归一化：兼容持久化 LLMToolCall（OpenAI 原生）与内存简化 ToolCall
   *   · 防御过滤：空 assistant / 孤立 tool / 悬空 tool_calls（防 API 400）
   *   · reasoning_content 仅最后一条 assistant 回传
   */
  toProviderMessages(messages: LLMRequestMessage[], viewer?: string): any[] {
    // 逐条解析 API 角色（含 role='agent' 的视角转换）
    const roles = messages.map((m) => resolveApiRole(m.role, m.agent_id, viewer));

    // ---- 防御：过滤不合法消息 ----
    let activeToolCallIds: Set<string> | null = null;
    const filtered: LLMRequestMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const apiRole = roles[i];
      // 空 assistant（无 content / tool_calls / reasoning）→ 丢弃
      if (apiRole === 'assistant' && !m.content && !m.tool_calls?.length && !m.reasoning_content) {
        log.warn(`已过滤空 assistant 消息（索引 ${i}），防止 API 400 错误`);
        continue;
      }
      // 跟踪活跃 tool_call_id 集合（视角转换为 user 的消息不参与 tool 配对）
      if (apiRole === 'assistant' && m.tool_calls?.length) {
        const norm = normalizeToolCalls(m.tool_calls) ?? [];
        activeToolCallIds = new Set(norm.map(tc => tc.id));
      } else if (apiRole !== 'tool') {
        activeToolCallIds = null;
      }
      // 孤儿 tool（tool_call_id 不匹配最近 assistant）→ 丢弃
      // 跨视角历史加载时，对方视角的 assistant（tool_calls）被转 user
      // 丢弃 tool_calls，其后的 tool 结果成为孤立——这是预期行为，降为 debug
      if (apiRole === 'tool' && (!activeToolCallIds || !activeToolCallIds.has(m.tool_call_id || ''))) {
        log.debug(`已过滤孤立 tool 消息 tool_call_id="${m.tool_call_id || '?'}" （索引 ${i}），防止 API 400 错误`);
        continue;
      }
      filtered.push(m);
    }

    // ---- 第二遍：移除 tool_calls 后缺 tool 结果的 assistant 及其孤儿 tool ----
    const safeMessages: LLMRequestMessage[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      const apiRole = resolveApiRole(m.role, m.agent_id, viewer);
      if (apiRole === 'assistant' && m.tool_calls?.length) {
        // 计数后续 tool 消息
        let toolCount = 0;
        let j = i + 1;
        while (j < filtered.length && (resolveApiRole(filtered[j].role, filtered[j].agent_id, viewer) === 'tool')) {
          toolCount++;
          j++;
        }
        const norm = normalizeToolCalls(m.tool_calls) ?? [];
        if (toolCount < norm.length) {
          log.warn(`已过滤悬空 tool_calls assistant（索引 ${i}），期望 ${norm.length} 个 tool，实际 ${toolCount} 个`);
          i = j - 1; // 跳过后续孤儿 tool，下一步 i++ 从 j 开始
          continue;
        }
      }
      safeMessages.push(m);
    }

    // ---- 构建 API 消息 ----
    // reasoning_content 仅回传给"最终输出中的最后一条 assistant"（基于过滤后数组重算，
    // 避免前置消息被过滤导致索引错位）
    let lastAssistantIdx = -1;
    for (let i = safeMessages.length - 1; i >= 0; i--) {
      if (resolveApiRole(safeMessages[i].role, safeMessages[i].agent_id, viewer) === 'assistant') { lastAssistantIdx = i; break; }
    }
    const out: any[] = [];
    for (let idx = 0; idx < safeMessages.length; idx++) {
      const m = safeMessages[idx];
      const apiRole = resolveApiRole(m.role, m.agent_id, viewer);
      const msg: any = { role: apiRole, content: m.content ?? '' };
      if (apiRole === 'tool') {
        msg.name = m.name || 'unknown';
        msg.tool_call_id = m.tool_call_id || 'call_missing';
      }
      // 视角转换为 user 的消息丢弃 tool_calls（协议正确性所必需——chat API 规定
      // user 角色不能携带 tool_calls，且 tool 消息必须紧跟匹配的 assistant；对方视角
      // 只需其回复，无需其工具调用；其 tool 结果随之成为孤立并被上方过滤）
      if (apiRole !== 'user' && m.tool_calls?.length) {
        const norm = normalizeToolCalls(m.tool_calls);
        if (norm?.length) {
          msg.tool_calls = norm.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
        }
      }
      if (m.reasoning_content && idx === lastAssistantIdx) msg.reasoning_content = m.reasoning_content;
      out.push(msg);
    }
    return out;
  }

  /**
   * 反向转换：将 LLM API 原生消息（OpenAI 格式）转换回项目消息。
   * 与 toProviderMessages 对称，转换动作全部收拢在 provider 内：
   *   · 角色：system/user/assistant/tool → 项目角色（tool_calls 归一化为简化 ToolCall，
   *     arguments 从 JSON 字符串解析为对象）
   *   · 主要用途：把 API 返回 / 持久化的 OpenAI 格式工具调用还原为项目格式
   */
  fromProviderMessages(messages: any[]): LLMRequestMessage[] {
    if (!messages) return [];
    return messages.map((m: any): LLMRequestMessage => {
      const norm = normalizeToolCalls(m.tool_calls);
      const role: LLMRequestMessage['role'] =
        (m.role === 'system' || m.role === 'tool' || m.role === 'user' || m.role === 'assistant')
          ? m.role
          : 'user';
      return {
        role,
        content: m.content ?? '',
        name: m.name,
        tool_call_id: m.tool_call_id,
        reasoning_content: m.reasoning_content,
        tool_calls: norm?.length
          ? norm.map(tc => ({ id: tc.id, name: tc.name, arguments: parseToolArgs(tc.arguments) }))
          : undefined,
      };
    });
  }

  /**
   * 构建 POST chat/completions 的请求体。
   * 子类可覆盖以注入 provider 特有参数（如 DeepSeek thinking / logprobs）。
   */
  protected buildRequestBody(req: LLMRequest, stream: boolean): any {
    const body: any = {
      model: this.model, stream,
      messages: this.toProviderMessages(req.messages, req.viewer),
    };

    // 参数合并：请求级 > 实例默认
    const t = req.temperature != null ? req.temperature : this.temperature;
    if (t != null) body.temperature = t;
    const mt = req.maxTokens != null ? req.maxTokens : this.maxTokens;
    if (mt) body.max_tokens = mt;
    const tp = req.topP != null ? req.topP : this.topP;
    if (tp != null) body.top_p = tp;
    if (this.responseFormat && this.responseFormat !== 'text') body.response_format = { type: this.responseFormat };
    const st = req.stop != null ? req.stop : this.stop;
    if (st != null) body.stop = st;
    if (stream) body.stream_options = { include_usage: true };
    if (req.tools?.length) body.tools = req.tools.map(t => ({ type: 'function', function: t.function }));

    return body;
  }

  /**
   * 请求体 JSON 文本后处理（发送前钩子，子类可覆写）。
   * 默认原样返回；DeepSeek 覆写为 \x 规避（见 deepseek.ts）。
   */
  protected postProcessBodyJson(json: string): string {
    return json;
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 角色解析（provider 内部，双向转换共用）——含持久化格式的视角转换。
 * 持久化 role='agent'（归属由 agent_id 标记）：
 *   · agent_id === 'user'      → user（人类用户万年 user）
 *   · agent_id === viewer      → assistant（当前视角自己发的）
 *   · 其余（对方 Agent/无归属）→ user
 * 内存格式（user/assistant/tool/error/system）直接映射：
 *   · error → tool（错误视同工具结果）；未知角色（含读取层漏归一化的 event/trigger）兜底 user
 */
type ApiRole = 'system' | 'user' | 'assistant' | 'tool';
function resolveApiRole(
  role: string,
  agentId: string | undefined,
  viewer: string | undefined,
): ApiRole {
  switch (role) {
    case 'system': return 'system';
    case 'tool': return 'tool';
    case 'error': return 'tool';
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'agent': {
      if (agentId === 'user') return 'user';
      if (viewer && agentId === viewer) return 'assistant';
      return 'user';
    }
    default: return 'user';
  }
}

/** 归一化后的工具调用（arguments 为 JSON 字符串，API 序列化用） */
interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 归一化工具调用（provider 内部，双向转换共用）——兼容两种格式：
 *   · 持久化/API 格式（PersistedToolCall）：{ id, type:'function', function:{ name, arguments: string } }
 *   · 内存格式（ToolCall）：                { id, name, arguments: object }
 * 统一输出 { id, name, arguments: JSON 字符串 }。
 */
function normalizeToolCalls(
  toolCalls: LLMRequestMessage['tool_calls'] | undefined,
): NormalizedToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc) => {
    if ('function' in tc && tc.function) {
      // OpenAI 原生格式（持久化/API 消息携带）
      return { id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
    }
    // 简化格式（内存消息携带）：arguments 为对象
    const t = tc as ToolCall;
    return { id: t.id, name: t.name, arguments: JSON.stringify(t.arguments) };
  });
}

/** 安全解析工具调用 arguments（JSON 字符串 → 对象） */
function parseToolArgs(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/**
 * 从 API usage 提取标准化 LLMUsage（兼容 OpenAI / DeepSeek / GLM）。
 *
 * 缓存命中归一化（两种来源，见官方文档）：
 *   · DeepSeek：顶层 prompt_cache_hit_tokens / prompt_cache_miss_tokens（显式双字段）
 *   · GLM / OpenAI：嵌套 prompt_tokens_details.cached_tokens（仅命中数；
 *     GLM 官方对话补全文档：usage.prompt_tokens_details.cached_tokens
 *     「命中的缓存 Token 数量」，未命中数协议不提供 → 按
 *     prompt_tokens - cached_tokens 推导，下限 0）
 * 两者并存时 DeepSeek 顶层字段优先（显式语义优先于推导值）。
 * 参见: https://docs.bigmodel.cn/api-reference/模型-api/对话补全
 *       https://docs.bigmodel.cn/cn/guide/capabilities/cache
 */
export function extractUsage(raw: any): LLMUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const nestedCached = raw.prompt_tokens_details?.cached_tokens;
  let cacheHit: number | undefined = raw.prompt_cache_hit_tokens;
  let cacheMiss: number | undefined = raw.prompt_cache_miss_tokens;
  if (cacheHit === undefined && typeof nestedCached === 'number') {
    cacheHit = nestedCached;
    cacheMiss = Math.max((raw.prompt_tokens ?? 0) - nestedCached, 0);
  }
  return {
    prompt_tokens: raw.prompt_tokens ?? 0,
    completion_tokens: raw.completion_tokens ?? 0,
    total_tokens: raw.total_tokens ?? 0,
    ...(cacheHit !== undefined && { prompt_cache_hit_tokens: cacheHit }),
    ...(cacheMiss !== undefined && { prompt_cache_miss_tokens: cacheMiss }),
  };
}
