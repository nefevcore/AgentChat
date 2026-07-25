// ============================================================
// DeepSeek API 直连 —— 流式聊天
// ============================================================

import type { ApiSettings } from '../types';

interface StreamCallback {
  /** 增量文本内容 */
  onDelta?: (content: string) => void;
  /** 深度思考增量内容 */
  onReasoning?: (reasoning: string) => void;
  /** 流结束，返回完整内容 */
  onDone?: (fullContent: string, fullReasoning: string) => void;
  /** 出错 */
  onError?: (error: string) => void;
}

/**
 * 调用 DeepSeek Chat Completion API（流式）
 * 
 * API 文档: https://api-docs.deepseek.com/api/create-chat-completion
 */
export async function streamChat(
  settings: ApiSettings,
  messages: Array<{ role: string; content: string }>,
  callbacks: StreamCallback,
  signal?: AbortSignal,
): Promise<void> {
  const { apiKey, baseUrl, model, thinking, reasoningEffort, temperature, maxTokens } = settings;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // 思考模式
    thinking: thinking ? { type: 'enabled' } : { type: 'disabled' },
    reasoning_effort: reasoningEffort,
  };

  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (maxTokens !== undefined && maxTokens !== null) body.max_tokens = maxTokens;

  let fullContent = '';
  let fullReasoning = '';

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      let errMsg: string;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errText;
      } catch {
        errMsg = errText;
      }
      callbacks.onError?.(`API 错误 (${resp.status}): ${errMsg}`);
      return;
    }

    // 读取 SSE 流
    const reader = resp.body?.getReader();
    if (!reader) {
      callbacks.onError?.('无法读取响应流');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一个可能不完整，留在 buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6); // 去掉 "data: "
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          if (delta?.reasoning_content) {
            fullReasoning += delta.reasoning_content;
            callbacks.onReasoning?.(delta.reasoning_content);
          }
          if (delta?.content) {
            fullContent += delta.content;
            callbacks.onDelta?.(delta.content);
          }
        } catch {
          // 忽略无法解析的 chunk
        }
      }
    }

    callbacks.onDone?.(fullContent, fullReasoning);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      callbacks.onDone?.(fullContent, fullReasoning);
      return;
    }
    callbacks.onError?.(`请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
