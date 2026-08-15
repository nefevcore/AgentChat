// ============================================================
// @agentchat/llm/src/adapters.ts —— LLM 适配器工厂（可替换后端）
//
// 契约化阶段④（2026-08-14）：把 createLLM 的 provider 分发拆成独立工厂，
// 供两类使用方：
//   · createLLM（库级回退分发，行为不变）
//   · 适配器插件行（plugin-deepseek / plugin-openai）经 ctx.llm.registerAdapter
//     注册进 LLMService —— 组合决定装哪些适配器（DSH llm-deepseek 模式）。
//
// 铁律：零外部依赖，仅引用本包适配器类。
// ============================================================
import type { LLMConfig, LLMProvider } from './contracts';
import { OpenAIChatLLM, type OpenAIChatConfig } from './openai';
import { DeepSeekChatLLM, type DeepSeekConfig } from './deepseek';

/** 适配器工厂签名：LLMConfig（snake_case）→ 适配器实例 */
export type AdapterFactory = (config: LLMConfig) => LLMProvider;

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
    reasoningEffort: config.reasoning_effort,
    thinking: config.thinking,
    logprobs: config.logprobs,
    topLogprobs: config.top_logprobs,
    toolChoice: config.tool_choice,
  };
  return new DeepSeekChatLLM(deepSeekCfg);
}
