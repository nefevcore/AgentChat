// ============================================================
// @agentchat/llm-openai/src/adapters.ts —— OpenAI 适配器工厂
//
// 抽象契约（LLMConfig/LLMProvider/resolveApiKey）来自 @agentchat/llm；
// 实现注册由本包插件行完成（provider: 'openai' + 'default'）。
// ============================================================
import type { LLMConfig, LLMProvider } from '@agentchat/llm';
import { resolveApiKey } from '@agentchat/llm';
import { OpenAIChatLLM } from './openai';
import type { OpenAIChatConfig } from './openai';

/** OpenAI 兼容适配器（默认兜底 provider） */
export function openaiAdapter(config: LLMConfig): LLMProvider {
  const base: OpenAIChatConfig = {
    apiKey: resolveApiKey(config.api_key),
    baseURL: config.base_url,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
    topP: config.top_p,
    responseFormat: config.response_format,
    stop: config.stop,
  };
  return new OpenAIChatLLM(base);
}
