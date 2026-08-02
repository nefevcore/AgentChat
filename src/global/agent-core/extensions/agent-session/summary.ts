// ============================================================
// agent-session summary —— 上下文压缩（摘要生成）
// ============================================================

import { LLMProvider, LLMRequestMessage } from '@core/types';
import { estimateTokens } from './history';
import { agentLabel } from './utils';
import { logger } from '../../../../utils/logger';

/**
 * 调用 LLM 将早期消息列表压缩为一段自然语言摘要。
 * 若 LLM 返回空内容，则返回兜底文本。
 */
export async function generateSummary(
  llm: LLMProvider | undefined,
  olderMessages: LLMRequestMessage[],
  counterpart: string,
  agent: string,
  summaryPreviewLen: number,
): Promise<string> {
  // 用 provider 的正向转换渲染 LLM 视角（角色已解析为 user/assistant、工具调用已归一化），
  // 转换动作收拢在 provider 内，会话层不再自行归一化工具调用。
  const apiMessages = llm ? llm.toProviderMessages(olderMessages, agent) : (olderMessages as any[]);
  const dialogueText = apiMessages
    .map((m: any) => {
      const label = m.name ? ` (${m.name})` : '';
      const toolNames = (m.tool_calls || []).map((tc: any) => tc?.function?.name ?? tc?.name).filter(Boolean);
      const toolCalls = toolNames.length ? `\n  [工具调用: ${toolNames.join(', ')}]` : '';
      // 不截断消息内容，完整传入让 LLM 自行提取关键信息
      return `[${m.role}${label}] ${m.content}${toolCalls}`;
    })
    .join('\n\n');

  const summaryPrompt: LLMRequestMessage = {
    role: 'system',
    content:
      `你是一个对话摘要助手。请用简洁自然的语言，总结以下 ${agentLabel(agent)} 与 ${agentLabel(counterpart)} 之间的早期对话内容。\n\n` +
      `要求：\n` +
      `1. 使用中文、自然流畅的叙述语气，像写日记一样\n` +
      `2. 保留关键决策、重要结论、用户偏好和待办事项\n` +
      `3. 忽略纯工具调用（如文件读写、命令执行）的技术细节，只记录其目的和结果\n` +
      `4. 对话可能很长，请提取核心要点而非逐条复述\n` +
      `5. 控制在 ${summaryPreviewLen} 字以内\n` +
      `6. 以"此前，"开头`,
  };
  const userMsg: LLMRequestMessage = {
    role: 'user',
    content: `请总结以下对话：\n\n${dialogueText}`,
  };

  const resp = await llm!.chat({ messages: [summaryPrompt, userMsg] });
  const text = (resp.content ?? '').trim();
  if (text) {
    logger.info(`[agent-session] LLM 摘要生成成功 (${estimateTokens(text)} tokens)`);
    return text;
  }
  logger.warn('[agent-session] LLM 摘要返回空内容');
  return '(摘要生成失败)';
}
