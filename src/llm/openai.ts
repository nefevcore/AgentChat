// ============================================================
// OpenAI 兼容的 LLM 适配器
// 支持 OpenAI / DeepSeek / Ollama 等兼容 API
// 支持流式输出 (Server-Sent Events)
// 使用原生 fetch 发送 HTTP 请求，确保 JSON 字段完全可控
// ============================================================

import { LLMRequest, LLMResponse, LLMUsage, ToolCall } from '../core/types';
import { BaseLLM } from './base';
import { ChatStream } from './chat-stream';

export interface OpenAIChatConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
}

export class OpenAIChatLLM extends BaseLLM {
  protected apiKey: string;
  protected baseURL: string;
  protected temperature: number;
  /** 最大输出 token（undefined 或 0 时不传给 API，由模型自行决定） */
  protected maxTokens: number | undefined;
  /** 日志前缀，子类可覆盖 */
  protected logPrefix: string = '[OpenAIChatLLM]';

  constructor(config: OpenAIChatConfig) {
    super(config.model ?? 'gpt-4o');
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com/v1';
    this.temperature = config.temperature ?? 0.7;
    const mt = config.maxTokens ?? 0;
    this.maxTokens = (mt && mt > 0) ? mt : undefined;
  }

  /** 非流式调用 —— stream().result() 的语法糖 */
  async chat(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    return this.stream(req, signal).result();
  }

  /** 流式调用 —— 返回 ChatStream（AsyncIterable + .result()） */
  stream(req: LLMRequest, signal?: AbortSignal): ChatStream {
    const cs = new ChatStream();
    this._runStream(req, signal, cs).catch(err => {
      console.error(`${this.logPrefix} 流式未捕获错误：`, err);
      cs.error(
        { content: null, toolCalls: [], finishReason: 'error' },
        `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return cs;
  }

  private async _runStream(req: LLMRequest, signal: AbortSignal | undefined, cs: ChatStream): Promise<void> {
    let usage: LLMUsage | undefined;
    let fullContent = '';
    let fullReasoning = '';

    try {
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

            if (delta.reasoning_content) {
              if (!thinkingStarted) {
                cs.push({ type: 'thinking_start', partial: partial() });
                thinkingStarted = true;
              }
              fullReasoning += delta.reasoning_content;
              cs.push({ type: 'thinking_update', delta: delta.reasoning_content, partial: partial() });
            }
            if (delta.content) {
              if (thinkingStarted) {
                cs.push({ type: 'thinking_end', partial: partial() });
                thinkingStarted = false;
              }
              if (!messageStarted) {
                cs.push({ type: 'message_start', partial: partial() });
                messageStarted = true;
              }
              fullContent += delta.content;
              cs.push({ type: 'message_update', delta: delta.content, partial: partial() });
            }
            if (delta.tool_calls) {
              // 关闭可能正在进行的 thinking / message 阶段
              if (thinkingStarted) {
                cs.push({ type: 'thinking_end', partial: partial() });
                thinkingStarted = false;
              }
              if (messageStarted) {
                cs.push({ type: 'message_end', partial: partial() });
                messageStarted = false;
              }
              for (const tc of delta.tool_calls) {
                const existing = tcAcc.get(tc.index);
                if (!existing) {
                  tcAcc.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' });
                  cs.push({
                    type: 'toolcall_start', partial: partial(),
                    toolCall: { index: tc.index, id: tc.id, name: tc.function?.name, arguments: '' },
                  });
                }
                const acc = tcAcc.get(tc.index)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                  acc.arguments += tc.function.arguments;
                  cs.push({
                    type: 'toolcall_update', delta: tc.function.arguments, partial: partial(),
                    toolCall: { index: tc.index, name: acc.name, arguments: acc.arguments },
                  });
                }
              }
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      // 关闭所有未结束的阶段
      if (thinkingStarted) {
        cs.push({ type: 'thinking_end', partial: partial() });
      }
      if (messageStarted || tcAcc.size > 0) {
        cs.push({ type: 'message_end', partial: partial() });
      }

      // 发射 toolcall_end 事件（每个完成的 tool call）
      for (const [index, acc] of tcAcc) {
        cs.push({
          type: 'toolcall_end', partial: partial(),
          toolCall: { index, id: acc.id, name: acc.name, arguments: acc.arguments },
        });
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
        cs.error(
          { content: fullContent || null, toolCalls: [], finishReason: 'error', reasoning: fullReasoning || undefined, usage },
          '请求已被中止',
        );
      } else {
        console.error(`${this.logPrefix} Stream 错误：${err.message}`);
        cs.error(
          { content: fullContent || null, toolCalls: [], finishReason: 'error', reasoning: fullReasoning || undefined, usage },
          `LLM 流式调用失败：${err.message}`,
        );
      }
    }
  }

  /**
   * 构建请求体 —— 直接用 fetch 发送，确保字段完全可控。
   * 子类可覆盖以注入 provider 特有参数（如 DeepSeek thinking）。
   */
  protected buildRequestBody(req: LLMRequest, stream: boolean): any {
    const body: any = {
      model: this.model,
      temperature: this.temperature,
      stream,
      messages: req.messages.map((m) => {
        const msg: any = {
          role: m.role,
          content: m.content,
        };
        // tool 角色消息必须提供 name（函数名），其他角色不传 name 字段
        if (m.role === 'tool') {
          msg.name = m.name || 'unknown';
        }
        if (m.tool_calls && m.tool_calls.length > 0) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        if (m.tool_call_id !== undefined && m.tool_call_id !== null) {
          msg.tool_call_id = m.tool_call_id;
        }
        // 回传 reasoning_content（DeepSeek 多轮对话要求，对 OpenAI 无害）
        if (m.reasoning_content) {
          msg.reasoning_content = m.reasoning_content;
        }
        return msg;
      }),
    };

    // 仅当 maxTokens 有效（>0）时才传输
    if (this.maxTokens) {
      body.max_tokens = this.maxTokens;
    }

    if (stream) {
      body.stream_options = { include_usage: true };
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function' as const,
        function: t.function,
      }));
    }

    return body;
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 从 API 返回的 usage 对象提取标准化的 LLMUsage。
 * 兼容 OpenAI / DeepSeek 格式。
 */
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
    try {
      result.push({ id: a.id, name: a.name, arguments: JSON.parse(a.arguments || '{}') });
    } catch {
      result.push({ id: a.id, name: a.name, arguments: {} });
    }
  }
  return result;
}
