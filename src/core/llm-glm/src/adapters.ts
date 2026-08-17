// ============================================================
// @agentchat/llm-glm/src/adapters.ts —— GLM 适配器工厂
//
// GLM 继承 OpenAI 兼容基类，注入 thinking/reasoning_effort 专属参数，
// 并在 buildRequestBody 内收敛 tool_choice/stop/采样等协议差异。
// ============================================================
import type { LLMConfig, LLMProvider } from '@agentchat/llm';
import { resolveApiKey } from '@agentchat/llm';
import type { OpenAIChatConfig } from '@agentchat/llm-openai';
import { GLMChatLLM } from './glm';
import type { GLMConfig } from './glm';

/** GLM 适配器（thinking/reasoning_effort 专属参数 + 协议差异收敛） */
export function glmAdapter(config: LLMConfig): LLMProvider {
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
  const glmCfg: GLMConfig = {
    ...base,
    reasoningEffort: config.reasoning_effort,
    thinking: config.thinking,
  };
  return new GLMChatLLM(glmCfg);
}
