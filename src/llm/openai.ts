// ============================================================
// OpenAI 兼容的 LLM 适配器
// 支持 OpenAI / DeepSeek / Ollama 等兼容 API
// 支持流式输出 (Server-Sent Events)
// 使用原生 fetch 发送 HTTP 请求，确保 JSON 字段完全可控
// ============================================================

import { LLMRequest, LLMResponse, LLMUsage, ToolCall } from '../core/types';
import { BaseLLM } from './base';

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

  async chat(
    req: LLMRequest,
    signal?: AbortSignal,
    onChunk?: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): Promise<LLMResponse> {
    // 无回调 → 非流式
    if (!onChunk) {
      return this._chatSync(req, signal);
    }
    return this._chatStream(req, signal, onChunk, onThinking);
  }

  private async _chatSync(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    try {
      const body = this.buildRequestBody(req, false);
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${res.status} ${errText}`);
      }

      const json: any = await res.json();
      const choice = json.choices[0];
      const message = choice.message;

      const toolCalls = (message.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      return {
        content: message.content,
        toolCalls,
        finishReason: (choice.finish_reason as LLMResponse['finishReason']) ?? 'stop',
        reasoning: message.reasoning_content || undefined,
        usage: extractUsage(json.usage),
      };
    } catch (err: any) {
      console.error(`${this.logPrefix} 错误：${err.message}`);
      return {
        content: `LLM 调用失败：${err.message}`,
        toolCalls: [],
        finishReason: 'error',
      };
    }
  }

  private async _chatStream(
    req: LLMRequest,
    signal: AbortSignal | undefined,
    onChunk: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): Promise<LLMResponse> {
    let streamUsage: LLMUsage | undefined;
    let fullContent = '';
    let fullReasoning = '';
    try {
      const body = this.buildRequestBody(req, true);
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
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

      const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

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

            // 流式模式下 usage 随最后一个带 finish_reason 的 delta 一起返回
            // usage 所在的 chunk 中 choices 非空（含 finish_reason），不能跳过 delta 处理
            if (chunk.usage) {
              streamUsage = extractUsage(chunk.usage);
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // 思考内容 (DeepSeek R1 等模型)
            if (delta.reasoning_content && onThinking) {
              onThinking(delta.reasoning_content);
              fullReasoning += delta.reasoning_content;
            }

            // 文本内容
            if (delta.content) {
              onChunk(delta.content);
              fullContent += delta.content;
            }

            // 工具调用（流式累积）
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index;
                if (!toolCallAccumulator.has(index)) {
                  toolCallAccumulator.set(index, {
                    id: tc.id ?? '',
                    name: tc.function?.name ?? '',
                    arguments: '',
                  });
                }
                const acc = toolCallAccumulator.get(index)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              }
            }
          } catch {
            // 跳过格式异常的 SSE 行
          }
        }
      }

      // 构建 ToolCall 数组
      const toolCalls: ToolCall[] = [];
      for (const acc of toolCallAccumulator.values()) {
        try {
          toolCalls.push({
            id: acc.id,
            name: acc.name,
            arguments: JSON.parse(acc.arguments || '{}'),
          });
        } catch {
          toolCalls.push({
            id: acc.id,
            name: acc.name,
            arguments: {},
          });
        }
      }

      return {
        content: fullContent || null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        reasoning: fullReasoning || undefined,
        usage: streamUsage,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return {
          content: fullContent || null,
          toolCalls: [],
          finishReason: 'error',
          reasoning: fullReasoning || undefined,
          usage: streamUsage,
        };
      }
      console.error(`${this.logPrefix} Stream 错误：${err.message}`);
      return {
        content: fullContent || `LLM 流式调用失败：${err.message}`,
        toolCalls: [],
        finishReason: 'error',
        usage: streamUsage,
      };
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

// ====================================================================
// 工具函数
// ====================================================================

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
