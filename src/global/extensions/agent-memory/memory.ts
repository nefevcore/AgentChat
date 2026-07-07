// ====================================================================
// agent-memory memory —— 长期记忆管理
//
// 每轮对话后由 LLM 基于"旧记忆 + 本轮对话"直接重写整个 memory.md，
// LLM 自行完成合并、去重、丢弃、精简，不再需要分阶段提取/压缩。
//
// 与摘要的关键区别：
//   摘要 → 短期、token 超阈值触发、注入 history、本会话有效
//   记忆 → 长期、每轮触发、写入 memory.md、跨会话有效
// ====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Message } from '../../../core/types';
import { resolveMemoryPath } from './paths';
import { cfg } from './config';
import { agentLabel } from './utils';

// ====================================================================
// 长期记忆 —— memory.md 读写
// ====================================================================

/**
 * 加载 Agent 对 counterpart 的长期记忆。
 * 返回 memory.md 的原始内容，不存在时返回 null。
 */
export function loadMemory(agent: string, counterpart: string): string | null {
  const filePath = resolveMemoryPath(agent, counterpart);
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * 更新长期记忆。
 *
 * 每轮对话后，将旧记忆 + 本轮对话一起发给 LLM，让 LLM 直接输出
 * 新的 memory.md 完整内容并覆盖写入。LLM 自行负责：
 *   · 合并新旧信息（自然去重）
 *   · 丢弃过时/不再相关的内容
 *   · 控制条目数量在合理范围内
 */
export async function updateMemory(
  agent: string,
  counterpart: string,
  ctx: AgentContext,
  response: string,
): Promise<void> {
  // 1. 读取旧记忆（原始 Markdown）
  let oldMemory = '';
  try {
    oldMemory = fs.readFileSync(resolveMemoryPath(agent, counterpart), 'utf-8').trim();
  } catch {
    // memory.md 不存在 → 首次创建
  }

  // 2. 组装本轮对话摘要
  const exchange = buildExchangeSummary(ctx, response);

  // 3. LLM 直接重写记忆
  const newContent = await rewriteMemory(ctx, agent, counterpart, oldMemory, exchange);

  if (!newContent) return; // LLM 认为无需更新

  // 4. 覆盖写入 memory.md
  const filePath = resolveMemoryPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, newContent, 'utf-8');
}

// ====================================================================
// 组装本轮对话摘要（供 LLM 参考）
// ====================================================================

function buildExchangeSummary(ctx: AgentContext, response: string): string {
  const userMsg = ctx.currentMessage?.content ?? '';
  const toolCalls = ctx.loopMessages
    ?.filter((m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls?.length))
    .map((m) => {
      if (m.role === 'tool') return `[工具结果: ${m.content.slice(0, 200)}]`;
      const calls = m.tool_calls?.map((tc) => tc.name).join(', ');
      return `[调用工具: ${calls}]`;
    }) ?? [];

  return [
    `用户: ${userMsg.slice(0, 800)}`,
    ...toolCalls,
    `助手: ${response.slice(0, 800)}`,
  ].join('\n');
}

// ====================================================================
// LLM 直接重写整个 memory.md
//
// 将旧记忆 + 本轮对话一起发给 LLM，由 LLM 输出完整的 memory.md。
// 去重、合并、丢弃、精简全部由 LLM 在一次调用中完成。
// ====================================================================

async function rewriteMemory(
  ctx: AgentContext,
  agent: string,
  counterpart: string,
  oldMemory: string,
  exchange: string,
): Promise<string | null> {
  const maxFacts = cfg(ctx).maxMemoryFacts;

  const oldBlock = oldMemory
    ? `\n## 当前记忆\n${oldMemory}`
    : '\n（暂无旧记忆，这是第一次记录）';

  const systemMsg: Message = {
    role: 'system',
    content:
      `你是 ${agentLabel(agent)} 的长期记忆管理器，负责维护对 ${agentLabel(counterpart)} 的记忆档案。\n\n` +
      `你的任务是：基于当前记忆 + 本轮新对话，输出更新后的完整记忆文件。\n\n` +
      `规则：\n` +
      `1. 保留有价值的旧信息（偏好、决策、待办、用户画像等）\n` +
      `2. 融入本轮对话中值得记住的新信息\n` +
      `3. 合并语义重复或相近的条目\n` +
      `4. 丢弃已过时、已解决、不再相关的信息\n` +
      `5. 控制在 ${maxFacts} 条以内，优先保留重要信息\n\n` +
      `输出格式：\n` +
      `# ${agentLabel(agent)} 对 ${agentLabel(counterpart)} 的记忆\n\n` +
      `- 条目一\n` +
      `- 条目二\n` +
      `...\n\n` +
      `只输出记忆文件内容，不要加任何额外说明。如果本轮没有任何值得更新/新增的信息，只回复 NO_CHANGE。`,
  };
  const userMsg: Message = {
    role: 'user',
    content: `${oldBlock}\n\n## 本轮对话\n${exchange}`,
  };

  const resp = await ctx.llm!.chat({ messages: [systemMsg, userMsg] });
  const text = (resp.content ?? '').trim();

  if (!text || text.toUpperCase().startsWith('NO_CHANGE')) {
    console.log('[agent-memory] 记忆无需更新');
    return null;
  }

  console.log(`[agent-memory] LLM 重写记忆完成`);
  return text;
}
