// ============================================================
// @agentchat/llm-factory —— LLM 适配器分发工厂（库级回退）
//
// 组合装配场景优先走 ctx.llm.create（适配器插件行注册，可替换后端）。
// 本包只服务"直接拿 LLMConfig 构造适配器"的库级调用方（如 L4 门面、
// 无 cordis 场景），provider 分发逻辑与旧 createLLM 一致。
// ============================================================
import type { LLMConfig, LLMProvider } from '@agentchat/llm';
import { openaiAdapter } from '@agentchat/llm-openai';
import { deepseekAdapter } from '@agentchat/llm-deepseek';

export function createLLM(config: LLMConfig): LLMProvider {
  return config.provider === 'deepseek' ? deepseekAdapter(config) : openaiAdapter(config);
}
