// ============================================================
// ac-llm/src/readers.ts —— agentOf 命名读取器（M25 §3.2）
//
// llm 域的身份通道 = input.meta.agent（loop 注入的 LlmStreamMeta——
// M13 载荷增强；dispatch 时剥离不进 provider body）。读取器住 owning
// 包、类型锚定自家 contract。
// ============================================================
import type { LlmChatCall, LlmChatInput } from './contract.ts';

/** llm/before-chat 载体 → meta.agent 通道的发起 Agent id */
export function agentOfChatCall(call: LlmChatCall): string | undefined {
  return call.input.meta?.agent;
}

/** llm/chat-error · llm/delta-* 首参（LlmChatInput）→ meta.agent 通道 */
export function agentOfChatInput(input: LlmChatInput): string | undefined {
  return input.meta?.agent;
}
