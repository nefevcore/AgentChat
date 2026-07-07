// ====================================================================
// agent-session archive —— 归档与重建
// ====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Message } from '../../../core/types';
import { resolveMessagePath, resolveArchiveDir } from './paths';
import { cfg } from './config';
import { appendJSONL, estimateTokens, safeJsonParse } from './history';
import { PersistedMessage } from './types';

// ====================================================================
// 本轮消息暂存区
//
// 用于在 preHook → postHook 之间传递本轮新产生的消息。
// 归档时 (archiveAndRebuild) 也会读取此数组以追加本轮消息。
//
// 使用 WeakMap<AgentContext, PersistedMessage[]> 替代模块级变量：
// 每个 Agent.run() 调用持有独立的 AgentContext 引用，WeakMap 以
// 此为键自然隔离不同会话的暂存消息。AgentContext 回收时自动清理。
// ====================================================================

/** 按 AgentContext 隔离的本轮暂存消息 */
const sessionPendingMessages = new WeakMap<AgentContext, PersistedMessage[]>();

/** 获取当前会话的暂存消息数组（不存在则自动创建） */
export function getPendingMessages(ctx: AgentContext): PersistedMessage[] {
  let msgs = sessionPendingMessages.get(ctx);
  if (!msgs) {
    msgs = [];
    sessionPendingMessages.set(ctx, msgs);
  }
  return msgs;
}

/** 清理本轮缓存 */
export function clearPendingMessages(ctx: AgentContext): void {
  sessionPendingMessages.delete(ctx);
}

// ====================================================================
// 归档与重建
//
// 由 postHook 在 token 超阈值时调用。流程：
//   1. 将当前 messages.jsonl 重命名为 archive/history_<N>.jsonl
//   2. 从尾部保留近期消息至安全水位（≤ 80% maxContextTokens），
//      重建 messages.jsonl，保证下一轮会话加载时无需立即压缩
//
// 设计意图：
//   归档负责"物理保障"（重建文件 ≤ 安全水位），
//   preHook 压缩仅在异常长单轮消息时作为兜底触发。
//   两者互不依赖，各司其职。
// ====================================================================

export async function archiveAndRebuild(
  agent: string,
  counterpart: string,
  ctx: AgentContext,
): Promise<void> {
  const msgPath = resolveMessagePath(agent, counterpart);
  const archiveDir = resolveArchiveDir(agent, counterpart);

  if (!fs.existsSync(msgPath)) return;

  // 1. 计算归档编号（已有归档文件数 + 1）
  let archiveCount = 0;
  if (fs.existsSync(archiveDir)) {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
    archiveCount = files.length;
  } else {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // 2. 移动当前 messages.jsonl 到归档
  const archivePath = path.join(archiveDir, `history_${archiveCount + 1}.jsonl`);
  fs.renameSync(msgPath, archivePath);
  console.log(
    `[agent-session] 已归档：${msgPath} → ${archivePath}`
  );

  // 3. 收集待重建的全部消息（压缩后历史 + 本轮缓存）
  //    将 PersistedMessage 转为 Message 兼容结构，供 truncateTail 消费
  const pendingAsMessages: Message[] = getPendingMessages(ctx).map((p) => ({
    role: p.role,
    content: p.content ?? '',
    tool_calls: p.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    })),
    agent_id: p.agent_id,
  }));
  const allMessages: Message[] = [...ctx.history, ...pendingAsMessages];

  // 4. 从尾部保留近期消息至安全水位，保证重建文件不会立刻触发下一轮压缩
  const maxTokens = cfg(ctx).maxContextTokens;
  const safeTarget = Math.ceil(maxTokens * 0.80);
  const truncated = truncateTail(allMessages, safeTarget);

  // 5. 写入重建后的 messages.jsonl
  for (const msg of truncated) {
    const p: PersistedMessage = {
      role: msg.role,
      content: msg.content,
      agent_id: msg.agent_id,
      tool_calls: msg.tool_calls
        ? msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }))
        : undefined,
      tool_call_id: msg.tool_call_id,
      reasoning_content: msg.reasoning_content,
      label: msg.label,
      timestamp: new Date().toISOString(),
    };
    appendJSONL(agent, counterpart, p);
  }

  const truncatedCount = allMessages.length - truncated.length;
  if (truncatedCount > 0) {
    console.log(
      `[agent-session] 归档重建截断 ${truncatedCount} 条早期消息，` +
      `保留 ${truncated.length} 条 (≤ ${safeTarget} tokens / ${maxTokens} 阈值)`
    );
  }
}

/**
 * 从尾部保留消息至指定 token 预算，丢弃早期消息。
 * 保证不切割 tool-call ↔ tool-response 对。
 *
 * @returns 截断后的尾部消息数组
 */
export function truncateTail(messages: Message[], tokenBudget: number): Message[] {
  let accumulated = 0;
  let splitIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content);
    // 允许略微超出预算，但不能超过 1.5x 且至少保留一条
    if (accumulated + msgTokens > tokenBudget * 1.5 && accumulated > 0) {
      break;
    }
    accumulated += msgTokens;
    splitIdx = i;
  }

  // 安全分割点：不拆分 tool-call/response 对
  while (splitIdx > 0 && splitIdx < messages.length) {
    const atSplit = messages[splitIdx];
    if (atSplit.role === 'tool') {
      let foundAssistant = false;
      for (let j = splitIdx - 1; j >= 0; j--) {
        if (messages[j].role === 'assistant' && messages[j].tool_calls?.length) {
          splitIdx = j;
          foundAssistant = true;
          break;
        }
        if ((messages[j].role === 'assistant' && !messages[j].tool_calls?.length) || messages[j].role === 'user') {
          break;
        }
      }
      if (!foundAssistant) break;
    } else {
      break;
    }
  }
  splitIdx = Math.max(0, splitIdx);

  return messages.slice(splitIdx);
}
