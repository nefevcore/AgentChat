// ============================================================
// token 估算 —— 共享模块（2026-08-02，B3：消除前后端重复实现）
//
// 前后端（src 核心 / webui/server）共用同一套估算逻辑，
// 避免各自维护导致算法漂移。
// ============================================================

/** 可参与 token 估算的消息结构（content / reasoning_content 即可） */
export interface TokenCountable {
  content?: string | null;
  reasoning_content?: string | null;
}

/**
 * 估算文本 token 数。
 * 中文字符约 0.6 token/字，英文字符约 0.3 token/字。
 * 这是一个近似值，用于阈值判断，不要求精确匹配 LLM tokenizer。
 */
export function estimateTokens(text: string | null | undefined): number {
  // 防御：tool 消息的 content 可能为 null（PersistedMessage.content 允许 null），
  // 无保护时 for...of null 抛 TypeError 导致整个会话加载失败。
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

/** 估算一组消息的 token 数（content + reasoning_content） */
export function estimateMessagesTokens<T extends TokenCountable>(messages: T[]): number {
  return messages.reduce((sum, m) => {
    let t = estimateTokens(m.content);
    if (m.reasoning_content) {
      t += estimateTokens(m.reasoning_content);
    }
    return sum + t;
  }, 0);
}
