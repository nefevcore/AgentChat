// ============================================================
// @agentchat/llm/src/adapters.ts —— LLM 适配器契约（抽象包）
//
// 契约化阶段④：适配器为可替换后端。抽象包只提供：
//   · AdapterFactory 类型（LLMConfig → LLMProvider）
//   · resolveApiKey（${ENV_VAR} 解析）
// 具体 openai/deepseek 实现位于 @agentchat/llm-openai / @agentchat/llm-deepseek。
// ============================================================
import type { LLMConfig, LLMProvider } from './contracts';

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
