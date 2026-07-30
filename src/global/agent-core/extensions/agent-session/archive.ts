// ============================================================
// agent-session archive —— 归档与重建
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { AgentContext, Message, MessageRole } from '@core/types';
import { resolveMessagePath, resolveArchiveDir } from './paths';
import { cfg } from './meta';
import { appendJSONL, estimateTokens, safeJsonParse } from './history';
import { logger } from '../../../../utils/logger';
import { PersistedMessage } from './types';

// ============================================================
// 本轮消息暂存区
//
// 用于在 preHook → postHook 之间传递本轮新产生的消息。
// 归档时 (archiveAndRebuild) 也会读取此数组以追加本轮消息。
//
// 使用 WeakMap<AgentContext, PersistedMessage[]> 替代模块级变量：
// 每个 Agent.run() 调用持有独立的 AgentContext 引用，WeakMap 以
// 此为键自然隔离不同会话的暂存消息。AgentContext 回收时自动清理。
// ============================================================

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

// ============================================================
// 归档与重建
//
// 由 postHook 在 token 超阈值时调用。流程：
//   1. 读取上一次归档的最后一条消息，检测重叠
//   2. 将 messages.jsonl 中未被上次归档覆盖的部分写入 archive/history_<N>.jsonl
//   3. 从尾部保留近期消息至安全水位（≤ 80% maxContextTokens），
//      重建 messages.jsonl，保证下一轮会话加载时无需立即压缩
//
// 二次归档去重：
//   truncateTail 每次保留尾部消息，导致相邻归档文件之间有重叠。
//   为避免 WebUI 回溯时出现重复消息，二次及后续归档时会读取上一次
//   归档的最后一条消息作为分界点，仅将新消息写入本次归档文件。
//
// 设计意图：
//   归档负责"物理保障"（重建文件 ≤ 安全水位），
//   preHook 压缩仅在异常长单轮消息时作为兜底触发。
//   两者互不依赖，各司其职。
// ============================================================

/**
 * 读取归档文件最后一条消息，用于二次归档去重。
 * 从文件末尾读取最多 8KB，解析最后一行完整 JSON。
 */
function readLastArchiveMessage(archiveDir: string, archiveIndex: number): PersistedMessage | null {
  const archivePath = path.join(archiveDir, `history_${archiveIndex}.jsonl`);
  if (!fs.existsSync(archivePath)) return null;

  const stats = fs.statSync(archivePath);
  if (stats.size === 0) return null;

  const readSize = Math.min(stats.size, 8192);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(archivePath, 'r');
  fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
  fs.closeSync(fd);

  const tail = buffer.toString('utf-8');
  const lines = tail.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;

  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * 在 allMessages 中查找与 target 匹配的消息索引。
 * 匹配规则：role + content 完全一致。
 * @returns 匹配的索引，未找到返回 -1
 */
function findMessageIndex(messages: Message[], target: PersistedMessage): number {
  const targetContent = target.content ?? '';
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === target.role && messages[i].content === targetContent) {
      return i;
    }
  }
  return -1;
}

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

  // 2. 读取上次归档的最后一条消息，用于二次归档去重
  let lastArchivedMsg: PersistedMessage | null = null;
  if (archiveCount > 0) {
    lastArchivedMsg = readLastArchiveMessage(archiveDir, archiveCount);
  }

  // 3. 收集待重建的全部消息（压缩后历史 + 本轮缓存）
  //    将 PersistedMessage 转为 Message 兼容结构，供 truncateTail 消费
  const pendingAsMessages: Message[] = getPendingMessages(ctx).map((p) => ({
    role: (p.role === 'trigger' ? 'user' : p.role === 'agent' ? 'assistant' : p.role) as MessageRole,
    content: p.content ?? '',
    tool_calls: p.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    })),
    agent_id: p.agent_id,
    name: p.name,
    tool_call_id: p.tool_call_id,
    reasoning_content: p.reasoning_content,
    label: p.label,
  }));
  let allMessages: Message[] = [...ctx.history, ...pendingAsMessages];

  // 4. 二次归档去重：移除上次归档已覆盖的消息
  //    ctx.history 即当前 messages.jsonl 的全部内容；
  //    通过匹配上次归档的最后一条消息，定位重叠分界点。
  let dedupCutoff = 0;
  if (lastArchivedMsg) {
    const matchIdx = findMessageIndex(ctx.history, lastArchivedMsg);
    if (matchIdx >= 0) {
      dedupCutoff = matchIdx + 1; // 跳过该消息及之前所有（已被上次归档覆盖）
    }
  }

  // 5. 先计算截断点，保证归档与 messages.jsonl 不重叠
  const maxTokens = cfg(ctx.runtimeConfig).maxContextTokens;
  const keepRecentRatio = cfg(ctx.runtimeConfig).keepRecentRatio;
  const safeTarget = Math.ceil(maxTokens * keepRecentRatio);
  const truncated = truncateTail(allMessages, safeTarget);
  const truncStart = allMessages.length - truncated.length;

  // 5a. 归档区间: [dedupCutoff, truncStart) —— 即被截掉且未被上次归档覆盖的消息
  const archiveMessages = allMessages.slice(dedupCutoff, Math.max(dedupCutoff, truncStart));
  const archivePath = path.join(archiveDir, `history_${archiveCount + 1}.jsonl`);

  if (archiveMessages.length > 0) {
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    for (const msg of archiveMessages) {
      const p: PersistedMessage = {
        role: (msg.content?.startsWith('<trigger>') || msg.content?.includes('<trigger>')) ? 'trigger' : (msg.role === 'assistant' ? 'agent' : msg.role as 'tool' | 'system' | 'error'),
        content: msg.content,
        message_id: msg.message_id,
        agent_id: msg.agent_id,
        name: msg.name,
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
      fs.appendFileSync(archivePath, JSON.stringify(p) + '\n', 'utf-8');
    }
  }

  if (archiveMessages.length > 0) {
    logger.info(
      dedupCutoff > 0
        ? `[agent-session] 二次归档去重：跳过前 ${dedupCutoff} 条，归档 ${archiveMessages.length} 条 (${truncStart - dedupCutoff} 区间) → ${archivePath}`
        : `[agent-session] 已归档：${archiveMessages.length} 条 (保留 ${truncated.length} 条近期) → ${archivePath}`
    );
  }

  // 删除原 messages.jsonl
  if (fs.existsSync(msgPath)) fs.unlinkSync(msgPath);

  // 6. 写入重建后的 messages.jsonl（仅保留尾部近期消息）
  for (const msg of truncated) {
    const p: PersistedMessage = {
      role: (msg.content?.startsWith('<trigger>') || msg.content?.includes('<trigger>')) ? 'trigger' : (msg.role === 'assistant' ? 'agent' : msg.role as 'tool' | 'system' | 'error'),
      content: msg.content,
      message_id: msg.message_id,
      agent_id: msg.agent_id,
      name: msg.name,
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
    logger.info(
      `[agent-session] 归档重建截断 ${truncatedCount} 条早期消息，` +
      `保留 ${truncated.length} 条 (≤ ${safeTarget} tokens / ${maxTokens} 阈值)`
    );
  }

  // 8. 写入记忆更新标记，通知 agent-memory 在下一轮触发长期记忆重写
  // agent-memory 使用方向敏感路径 (agent/counterpart/.memory_update_needed)
  const sessionsDir = path.resolve(msgPath, '..', '..', '..');
  const memoryMarkerPath = path.join(sessionsDir, agent, counterpart, '.memory_update_needed');
  const markerDir = path.dirname(memoryMarkerPath);
  if (!fs.existsSync(markerDir)) {
    fs.mkdirSync(markerDir, { recursive: true });
  }
  fs.writeFileSync(memoryMarkerPath, '', 'utf-8');
  logger.info('[agent-session] 已通知 agent-memory 更新长期记忆');
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
    let msgTokens = estimateTokens(messages[i].content);
    const rc = messages[i].reasoning_content;
    if (rc) {
      msgTokens += estimateTokens(rc);
    }
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
