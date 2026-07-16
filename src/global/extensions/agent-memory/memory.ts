// ============================================================
// agent-memory memory —— 长期记忆管理
//
// 记忆更新策略：归档驱动（而非每轮触发）
//
//   每轮对话后，agent-memory 将本轮对话摘要追加到 .memory_pending.jsonl，
//   LLM 重写只在 agent-session 归档消息后触发。
//
//   为什么这样设计？
//     · 归档 = 自然的信息检查点（积累了足够多的对话）
//     · 归档之间 memory.md 保持不变 → system prompt 稳定 → 缓存命中率高
//     · 减少了 80%+ 的记忆重写 LLM 调用
//
// 流程：
//   1. 每轮 → appendExchange() 追加到 .memory_pending.jsonl
//   2. agent-session 归档 → 写入 .memory_update_needed 标记
//   3. 下一轮 → agent-memory 检测标记 → 取所有 pending → LLM 重写 → 清除标记
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Message, LLMProvider } from '@core/types';
import { resolveMemoryPath, resolveMemoryPendingPath, resolveMemoryUpdateMarkerPath } from './paths';
import { cfg } from './meta';
import { agentLabel } from './utils';

// ============================================================
// 长期记忆 —— memory.md 读写
// ============================================================

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

// ============================================================
// 交换累积（每轮追加，不调 LLM）
// ============================================================

/**
 * 将本轮对话摘要追加到待处理缓冲区。
 * 每次调用追加一行 JSONL（每行一个 JSON 对象）。
 */
function appendExchange(agent: string, counterpart: string, exchange: string): void {
  const filePath = resolveMemoryPendingPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), exchange }) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');
}

/**
 * 读取待处理缓冲区中的所有交换摘要。
 */
function readPendingExchanges(agent: string, counterpart: string): string[] {
  const filePath = resolveMemoryPendingPath(agent, counterpart);
  const exchanges: string[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.exchange) exchanges.push(entry.exchange);
      } catch { /* skip malformed lines */ }
    }
  } catch {
    // 文件不存在 → 无待处理交换
  }
  return exchanges;
}

/**
 * 清空待处理缓冲区（仅在 LLM 重写成功后调用）。
 */
function clearPendingExchanges(agent: string, counterpart: string): void {
  const filePath = resolveMemoryPendingPath(agent, counterpart);
  try {
    fs.writeFileSync(filePath, '', 'utf-8');
  } catch { /* ignore */ }
}

// ============================================================
// 归档标记检测（由 agent-session 写入）
// ============================================================

/** agent-session 归档后写入此标记，agent-memory 据此触发记忆重写 */
export function markMemoryUpdateNeeded(agent: string, counterpart: string): void {
  const filePath = resolveMemoryUpdateMarkerPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, '', 'utf-8');
}

/** 检查并消费归档标记（存在则返回 true 并删除标记） */
function consumeUpdateMarker(agent: string, counterpart: string): boolean {
  const filePath = resolveMemoryUpdateMarkerPath(agent, counterpart);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ============================================================
// 记忆更新入口
// ============================================================

/**
 * 更新长期记忆（归档驱动）。
 *
 * 每轮对话后调用：
 *   1. 始终将本轮对话摘要追加到 .memory_pending.jsonl
 *   2. 检查 agent-session 是否写入了 .memory_update_needed 标记
 *   3. 有标记 → 取所有 pending → LLM 批量重写 memory.md → 清除标记
 *   4. 无标记 → 跳过（零 LLM 调用）
 */
export async function updateMemory(
  agent: string,
  counterpart: string,
  ctx: AgentContext,
  response: string,
): Promise<void> {
  // 1. 累积本轮对话摘要
  const exchange = buildExchangeSummary(ctx, response);
  appendExchange(agent, counterpart, exchange);

  // 2. 检查归档标记
  const needsUpdate = consumeUpdateMarker(agent, counterpart);
  if (!needsUpdate) {
    console.log('[agent-memory] 未检测到归档标记，跳过记忆重写（交换已累积）');
    return;
  }

  // 3. 读取旧记忆
  let oldMemory = '';
  try {
    oldMemory = fs.readFileSync(resolveMemoryPath(agent, counterpart), 'utf-8').trim();
  } catch {
    // memory.md 不存在 → 首次创建
  }

  // 4. 读取所有累积的交换（含本轮刚追加的）
  const pendingExchanges = readPendingExchanges(agent, counterpart);
  const allExchanges = pendingExchanges.join('\n\n---\n\n');

  if (pendingExchanges.length === 0) {
    console.log('[agent-memory] 归档触发但无累积交换，跳过记忆重写');
    return;
  }

  console.log(
    `[agent-memory] 归档触发记忆重写：${pendingExchanges.length} 轮累积对话`
  );

  // 5. LLM 重写记忆
  const newContent = await rewriteMemory(ctx.llm!, cfg(ctx.runtimeConfig).maxMemoryFacts, agent, counterpart, oldMemory, allExchanges);

  if (!newContent) {
    // NO_CHANGE 也清空 pending（这些对话已被评估为无需记忆）
    clearPendingExchanges(agent, counterpart);
    console.log('[agent-memory] 记忆无需更新，已清空累积');
    return;
  }

  // 6. 覆盖写入 memory.md
  const filePath = resolveMemoryPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, newContent, 'utf-8');

  // 7. 成功后清空 pending
  clearPendingExchanges(agent, counterpart);
  console.log('[agent-memory] 记忆已更新');
}

// ============================================================
// 组装本轮对话摘要（供 LLM 参考）
// ============================================================

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

// ============================================================
// LLM 直接重写整个 memory.md
//
// 将旧记忆 + 本轮对话一起发给 LLM，由 LLM 输出完整的 memory.md。
// 去重、合并、丢弃、精简全部由 LLM 在一次调用中完成。
// ============================================================

async function rewriteMemory(
  llm: LLMProvider,
  maxFacts: number,
  agent: string,
  counterpart: string,
  oldMemory: string,
  exchange: string,
): Promise<string | null> {

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
      `## ${agentLabel(agent)} 对 ${agentLabel(counterpart)} 的记忆\n\n` +
      `- 条目一\n` +
      `- 条目二\n` +
      `...\n\n` +
      `只输出记忆文件内容，不要加任何额外说明。如果本轮没有任何值得更新/新增的信息，只回复 NO_CHANGE。`,
  };
  const userMsg: Message = {
    role: 'user',
    content: `${oldBlock}\n\n## 本轮对话\n${exchange}`,
  };

  const resp = await llm.chat({ messages: [systemMsg, userMsg] });
  const text = (resp.content ?? '').trim();

  if (!text || text.toUpperCase().startsWith('NO_CHANGE')) {
    console.log('[agent-memory] 记忆无需更新');
    return null;
  }

  console.log(`[agent-memory] LLM 重写记忆完成`);
  return text;
}

// ============================================================
// 强制记忆更新（手动归档时立即触发）
//
// 与 updateMemory 的区别：
//   - updateMemory 在每轮 postHook 中调用，需要 ctx/response 来追加摘要
//   - forceUpdateMemory 由外部手动触发（如 WebUI 归档按钮），
//     不追加新摘要，直接取已累积的 pending 调用 LLM 重写
// ============================================================

export async function forceUpdateMemory(
  agent: string,
  counterpart: string,
  llm: LLMProvider,
): Promise<void> {
  // 1. 消费归档标记（避免下一轮重复处理）
  consumeUpdateMarker(agent, counterpart);

  // 2. 读取旧记忆
  let oldMemory = '';
  try {
    oldMemory = fs.readFileSync(resolveMemoryPath(agent, counterpart), 'utf-8').trim();
  } catch {
    // memory.md 不存在 → 首次创建
  }

  // 3. 读取所有累积的交换
  const pendingExchanges = readPendingExchanges(agent, counterpart);

  if (pendingExchanges.length === 0) {
    console.log('[agent-memory] 强制更新记忆但无累积交换，跳过');
    return;
  }

  const allExchanges = pendingExchanges.join('\n\n---\n\n');

  console.log(
    `[agent-memory] 强制记忆重写：${pendingExchanges.length} 轮累积对话`
  );

  // 4. LLM 重写记忆
  const newContent = await rewriteMemory(llm, cfg().maxMemoryFacts, agent, counterpart, oldMemory, allExchanges);

  if (!newContent) {
    clearPendingExchanges(agent, counterpart);
    console.log('[agent-memory] 记忆无需更新，已清空累积');
    return;
  }

  // 5. 覆盖写入 memory.md
  const filePath = resolveMemoryPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, newContent, 'utf-8');

  // 6. 清空 pending
  clearPendingExchanges(agent, counterpart);
  console.log('[agent-memory] 记忆已强制更新');
}
