// ============================================================
// agent-session summary —— 上下文压缩（摘要生成）
// ============================================================

import { LLMProvider, Message } from '../../../core/types';
import { estimateTokens } from './history';
import { agentLabel } from './utils';

/**
 * 调用 LLM 将早期消息列表压缩为一段自然语言摘要。
 * 若 LLM 返回空内容，则返回兜底文本。
 */
export async function generateSummary(
  llm: LLMProvider | undefined,
  olderMessages: Message[],
  counterpart: string,
  agent: string,
): Promise<string> {
  const dialogueText = olderMessages
    .map((m) => {
      const label = m.name ? ` (${m.name})` : '';
      const toolCalls = m.tool_calls?.length
        ? `\n  [工具调用: ${m.tool_calls.map(tc => tc.name).join(', ')}]`
        : '';
      const preview = m.content.slice(0, 800);
      const more = m.content.length > 800 ? '...' : '';
      return `[${m.role}${label}] ${preview}${more}${toolCalls}`;
    })
    .join('\n\n');

  const summaryPrompt: Message = {
    role: 'system',
    content:
      `你是一个对话摘要助手。请用简洁自然的语言，总结以下 ${agentLabel(agent)} 与 ${agentLabel(counterpart)} 之间的早期对话内容。\n\n` +
      `要求：\n` +
      `1. 使用中文、自然流畅的叙述语气，像写日记一样\n` +
      `2. 保留关键决策、重要结论、用户偏好和待办事项\n` +
      `3. 忽略纯工具调用（如文件读写）的技术细节，只记录其目的和结果\n` +
      `4. 控制在 300 字以内\n` +
      `5. 以"此前，"开头`,
  };
  const userMsg: Message = {
    role: 'user',
    content: `请总结以下对话：\n\n${dialogueText}`,
  };

  const resp = await llm!.chat({ messages: [summaryPrompt, userMsg] });
  const text = (resp.content ?? '').trim();
  if (text) {
    console.log(`[agent-session] LLM 摘要生成成功 (${estimateTokens(text)} tokens)`);
    return text;
  }
  console.warn('[agent-session] LLM 摘要返回空内容');
  return '(摘要生成失败)';
}
