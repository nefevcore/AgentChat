// ============================================================
// @agentchat/llm-deepseek/src/adapters.ts —— DeepSeek 适配器工厂
//
// DeepSeek 继承 OpenAI 兼容基类，仅注入 thinking/reasoning_effort/
// logprobs/tool_choice 等专属参数。
// ============================================================
import type { LLMConfig, LLMProvider } from '@agentchat/llm';
import { resolveApiKey } from '@agentchat/llm';
import type { OpenAIChatConfig } from '@agentchat/llm-openai';
import { DeepSeekChatLLM } from './deepseek';
import type { DeepSeekConfig } from './deepseek';

/** DeepSeek 适配器（thinking/reasoning_effort/logprobs/tool_choice 专属参数） */
export function deepseekAdapter(config: LLMConfig): LLMProvider {
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
  const deepSeekCfg: DeepSeekConfig = {
    ...base,
    // DeepSeek 仅支持 high/max（'low' 为 GLM-5.3 档位，此处降级为 high）
    reasoningEffort: config.reasoning_effort === 'low' ? 'high' : config.reasoning_effort,
    thinking: config.thinking,
    logprobs: config.logprobs,
    topLogprobs: config.top_logprobs,
    toolChoice: config.tool_choice,
  };
  return new DeepSeekChatLLM(deepSeekCfg);
}
