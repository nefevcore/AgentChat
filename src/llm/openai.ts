// ============================================================
// OpenAI 兼容的 LLM 适配器
// 支持 OpenAI / DeepSeek / Ollama 等兼容 API
// 支持流式输出 (Server-Sent Events)
// 使用原生 fetch 发送 HTTP 请求，确保 JSON 字段完全可控
// ============================================================

import { LLMRequest, LLMResponse, LLMUsage, ToolCall } from '@core/types';
import { BaseLLM } from './base';
import { ChatStream } from './chat-stream';
import { logger } from '../utils/logger';
import type { ConfigField } from '@discovery/config-types';

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

export const OPENAI_LLM_SCHEMA: ConfigField[] = [
  { name: 'api_key', label: 'API Key', description: 'AES-256-GCM 加密存储于 ~/.agentchat/credentials.json', type: 'password', default: '' },
  { name: 'base_url', label: 'API 地址', description: 'OpenAI 兼容 API 端点', type: 'text', default: 'https://api.openai.com/v1' },
  { name: 'model', label: '模型名称', description: '模型 ID，如 gpt-4o', type: 'text', default: 'gpt-4o' },
  { name: 'temperature', label: '温度', description: '控制输出随机性 (0-2)，留空使用默认值', type: 'ratio', default: undefined, min: 0, max: 2, step: 0.1, display: 'number' },
  { name: 'max_tokens', label: '最大 Token', description: '最大输出 token 数，留空不限制', type: 'number', default: undefined },
  { name: 'top_p', label: 'Top P', description: '核采样参数 (0-1)，留空使用默认值', type: 'ratio', default: undefined, min: 0, max: 1, step: 0.05, display: 'number' },
  { name: 'response_format', label: '输出格式', description: 'text=普通文本, json_object=强制JSON', type: 'select', default: undefined, options: [{ label: 'text', value: 'text' }, { label: 'JSON', value: 'json_object' }] },
  { name: 'stop', label: '停止词', description: '遇到即停止输出，逗号分隔多个', type: 'text', default: undefined },
];

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
    logger.info(`${this.logPrefix} API Key 已更新`);
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
      logger.error(`${this.logPrefix} 流式未捕获错误：`, err);
      cs.error(
        { content: null, toolCalls: [], finishReason: 'error' },
        `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return cs;
  }

  // ======== 流式管道 ========

  /**
   * 核心流式管道：
   *   1. 连通性预检（3s 快速失败）
   *   2. POST chat/completions
   *   3. 逐行解析 SSE → 发射 thinking / message / toolcall 事件
   *   4. 完成或出错时通知 ChatStream
   */
  private async _runStream(req: LLMRequest, signal: AbortSignal | undefined, cs: ChatStream): Promise<void> {
    let usage: LLMUsage | undefined;
    let fullContent = '';
    let fullReasoning = '';

    try {
      // ---- 1. 连通性预检 ----
      await this._probeConnectivity(signal);

      // ---- 2. 发送请求 ----
      const body = this.buildRequestBody(req, true);
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${res.status} ${errText}`);
      }

      // ---- 3. 解析 SSE 流 ----
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const tcAcc = new Map<number, { id: string; name: string; arguments: string }>();
      let thinkingStarted = false;
      let messageStarted = false;
      const partial = () => ({ content: fullContent, reasoning: fullReasoning });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

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
          } catch { /* skip malformed SSE chunk */ }
        }
      }

      // ---- 4. 收尾 ----
      if (thinkingStarted) cs.push({ type: 'thinking_end', partial: partial() });
      if (messageStarted || tcAcc.size > 0) cs.push({ type: 'message_end', partial: partial() });
      for (const [index, acc] of tcAcc) {
        cs.push({ type: 'toolcall_end', partial: partial(), toolCall: { index, id: acc.id, name: acc.name, arguments: acc.arguments } });
      }

      const toolCalls = buildToolCalls(tcAcc);
      cs.done({
        content: fullContent || null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        reasoning: fullReasoning || undefined,
        usage,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        cs.error({ content: fullContent || null, toolCalls: [], finishReason: 'error', reasoning: fullReasoning || undefined, usage }, '请求已被中止');
      } else {
        const errCode = err?.cause?.code ?? err?.code ?? '';
        const suffix = errCode ? ` (${errCode})` : '';
        const errMsg = `LLM 流式调用失败：${err.message}${suffix}`;
        logger.error(`${this.logPrefix} Stream 错误：${err.message}${suffix} [→ ${this.baseURL}/chat/completions]`);
        cs.error({ content: fullContent || null, toolCalls: [], finishReason: 'error', reasoning: fullReasoning || undefined, usage }, errMsg);
      }
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

    try {
      await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: probeAbort.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (externalSignal?.aborted) throw new Error('请求已被中止');
        throw new Error(`LLM 服务不可达：${this.baseURL}（连接超时，请检查网络/VPN/防火墙）`);
      }
      const errCode = err?.cause?.code ?? err?.code ?? '';
      if (errCode === 'ENOTFOUND' || errCode === 'EAI_AGAIN') throw new Error(`LLM 服务 DNS 解析失败：${this.baseURL}（请检查网络/VPN）`);
      if (errCode === 'ECONNREFUSED') throw new Error(`LLM 服务拒绝连接：${this.baseURL}（服务器可能未启动）`);
      if (errCode === 'EHOSTUNREACH' || errCode === 'ENETUNREACH') throw new Error(`LLM 服务网络不可达：${this.baseURL}（VPN 可能未连接）`);
      throw new Error(`LLM 服务不可达：${this.baseURL}（${err.message}）`);
    } finally {
      clearTimeout(probeTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ======== 请求构建（子类可覆写） ========

  /**
   * 构建 POST chat/completions 的请求体。
   * 子类可覆盖以注入 provider 特有参数（如 DeepSeek thinking / logprobs）。
   */
  protected buildRequestBody(req: LLMRequest, stream: boolean): any {
    // 找到最后一条 assistant，仅该条回传 reasoning_content（DeepSeek 多轮要求）
    let lastAssistantIdx = -1;
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }

    // ---- 防御：过滤不合法消息 ----
    let activeToolCallIds: Set<string> | null = null;
    const filtered: typeof req.messages = [];
    for (let i = 0; i < req.messages.length; i++) {
      const m = req.messages[i];
      // 空 assistant（无 content / tool_calls / reasoning）→ 丢弃
      if (m.role === 'assistant' && !m.content && !m.tool_calls?.length && !m.reasoning_content) {
        logger.warn(`[OpenAI] 已过滤空 assistant 消息（索引 ${i}），防止 API 400 错误`);
        continue;
      }
      // 跟踪活跃 tool_call_id 集合
      if (m.role === 'assistant' && m.tool_calls?.length) {
        activeToolCallIds = new Set(m.tool_calls.map(tc => tc.id));
      } else if (m.role !== 'tool' && m.role !== 'error') {
        activeToolCallIds = null;
      }
      // 孤儿 tool（tool_call_id 不匹配最近 assistant）→ 丢弃
      if (m.role === 'tool' && (!activeToolCallIds || !activeToolCallIds.has(m.tool_call_id || ''))) {
        logger.warn(`[OpenAI] ⚠️ 已过滤孤立 tool 消息 tool_call_id="${m.tool_call_id || '?'}" （索引 ${i}），防止 API 400 错误`);
        continue;
      }
      filtered.push(m);
    }

    // ---- 第二遍：移除 tool_calls 后缺 tool 结果的 assistant 及其孤儿 tool ----
    const safeMessages: typeof req.messages = [];
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      if (m.role === 'assistant' && m.tool_calls?.length) {
        // 计数后续 tool 消息
        let toolCount = 0;
        let j = i + 1;
        while (j < filtered.length && (filtered[j].role === 'tool' || filtered[j].role === 'error')) {
          if (filtered[j].role === 'tool') toolCount++;
          j++;
        }
        if (toolCount < m.tool_calls.length) {
          logger.warn(`[OpenAI] 已过滤悬空 tool_calls assistant（索引 ${i}），期望 ${m.tool_calls.length} 个 tool，实际 ${toolCount} 个`);
          i = j - 1; // 跳过后续孤儿 tool，下一轮 i++ 从 j 开始
          continue;
        }
      }
      safeMessages.push(m);
    }

    // ---- 构建请求体 ----
    const body: any = {
      model: this.model, stream,
      messages: safeMessages.map((m, idx) => {
        const msg: any = { role: m.role, content: m.content };
        if (m.role === 'tool') {
          msg.name = m.name || 'unknown';
          msg.tool_call_id = m.tool_call_id || 'call_missing';
        }
        if (m.tool_calls?.length) {
          msg.tool_calls = m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
        }
        if (m.reasoning_content && idx === lastAssistantIdx) msg.reasoning_content = m.reasoning_content;
        return msg;
      }),
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
}

// ============================================================
// 工具函数
// ============================================================

/** 从 API usage 提取标准化 LLMUsage（兼容 OpenAI / DeepSeek） */
function extractUsage(raw: any): LLMUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    prompt_tokens: raw.prompt_tokens ?? 0,
    completion_tokens: raw.completion_tokens ?? 0,
    total_tokens: raw.total_tokens ?? 0,
    ...(raw.prompt_cache_hit_tokens !== undefined && { prompt_cache_hit_tokens: raw.prompt_cache_hit_tokens }),
    ...(raw.prompt_cache_miss_tokens !== undefined && { prompt_cache_miss_tokens: raw.prompt_cache_miss_tokens }),
  };
}

/** 从流式累积器构建 ToolCall 数组 */
function buildToolCalls(acc: Map<number, { id: string; name: string; arguments: string }>): ToolCall[] {
  const result: ToolCall[] = [];
  for (const a of acc.values()) {
    try { result.push({ id: a.id, name: a.name, arguments: JSON.parse(a.arguments || '{}') }); }
    catch { result.push({ id: a.id, name: a.name, arguments: {} }); }
  }
  return result;
}
