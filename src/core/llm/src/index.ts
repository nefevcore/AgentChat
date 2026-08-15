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

import type { LLMConfig, LLMProvider } from './contracts';
import { BaseLLM } from './base';
import { ChatStream } from './chat-stream';
import { OpenAIChatLLM } from './openai';
import type { OpenAIChatConfig } from './openai';
import { DeepSeekChatLLM } from './deepseek';
import type { DeepSeekConfig } from './deepseek';
import { deepseekAdapter, openaiAdapter } from './adapters';

export * from './contracts';
export * from './base';
export * from './service';
export * from './chat-stream';
export * from './openai';
export * from './deepseek';
export * from './adapters';

export type { LLMConfig, LLMProvider };

/**
 * 从 LLMConfig（snake_case）创建 LLM 适配器。
 * 按 provider 分发：deepseek → DeepSeekChatLLM；其余 → OpenAIChatLLM。
 * （库级回退分发；组合场景经 ctx.llm + 适配器行，见 adapters.ts 头注）
 */
export function createLLM(config: LLMConfig): LLMProvider {
  return config.provider === 'deepseek' ? deepseekAdapter(config) : openaiAdapter(config);
}
