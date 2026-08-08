// ============================================================
// src/core/llm/index.ts —— 推理引擎出口 + 工厂
//
// createLLM(config)：把 LLMConfig（snake_case，来自 config.json / 模型池条目）
// 映射为具体适配器实例。参考配置（deepseek-v4-flash）：
//   {
//     "provider": "deepseek",
//     "base_url": "https://api.deepseek.com",
//     "model": "deepseek-v4-flash",
//     "reasoning_effort": "high",
//     "thinking": true,
//     "logprobs": false,
//     "tool_choice": "auto",
//     "default": true
//   }
//
// 铁律：零外部依赖。
// ============================================================

import type { LLMConfig, LLMProvider } from '../types';
import { BaseLLM } from './base';
import { ChatStream } from './chat-stream';
import { OpenAIChatLLM, OpenAIChatConfig } from './openai';
import { DeepSeekChatLLM, DeepSeekConfig } from './deepseek';

export * from './base';
export * from './chat-stream';
export * from './openai';
export * from './deepseek';

export type { LLMConfig, LLMProvider };

/**
 * 解析 API Key：支持 ${ENV_VAR} 环境变量引用。
 *   "api_key": "${DEEPSEEK_API_KEY}" → process.env.DEEPSEEK_API_KEY
 */
export function resolveApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  const m = apiKey.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (m && typeof process !== 'undefined') {
    return process.env?.[m[1]] ?? '';
  }
  return apiKey;
}

/**
 * 从 LLMConfig（snake_case）创建 LLM 适配器。
 * 按 provider 分发：deepseek → DeepSeekChatLLM；其余 → OpenAIChatLLM。
 */
export function createLLM(config: LLMConfig): DeepSeekChatLLM | OpenAIChatLLM {
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
  if (config.provider === 'deepseek') {
    const deepSeekCfg: DeepSeekConfig = {
      ...base,
      reasoningEffort: config.reasoning_effort,
      thinking: config.thinking,
      logprobs: config.logprobs,
      topLogprobs: config.top_logprobs,
      toolChoice: config.tool_choice,
    };
    return new DeepSeekChatLLM(deepSeekCfg);
  }
  return new OpenAIChatLLM(base);
}
