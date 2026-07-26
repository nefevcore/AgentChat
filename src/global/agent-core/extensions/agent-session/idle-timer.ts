// ============================================================
// agent-session idle-timer —— 空闲归档定时器
//
// 维护每个会话对 (agent, counterpart) 的定时器。
// 每次 postHook 触发时重置对应定时器；当定时器到期
//（即长时间无对话），自动触发归档。
//
// 设计要点：
//   - 定时器按会话对隔离，互不干扰
//   - 定时器在 postHook 末尾重置，确保一轮完整对话后才开始计时
//   - 归档时将 messages.jsonl 移入 archive/，并从尾部截取近期消息
//     重建 messages.jsonl（≤ 80% maxContextTokens），保证前端刷新
//     后仍可加载历史数据
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { resolveMessagePath, resolveArchiveDir } from './paths';
import { cfg } from './meta';
import { estimateTokens } from './history';
import { logger } from '../../../../utils/logger';
import type { PersistedMessage } from './types';

// ============================================================
// 配置
// ============================================================

/**
 * 获取空闲归档阈值（毫秒，供 setTimeout 使用）。
 */
function getIdleArchiveMs(): number {
  return cfg().idleArchiveSec * 1000;
}

// ============================================================
// 定时器管理
// ============================================================

/** 会话对键值 → 定时器映射 */
const timerMap = new Map<string, NodeJS.Timeout>();

/** 生成会话对的唯一键（利用 resolveMessagePath 的 Canonical Ordering） */
function pairKey(agent: string, counterpart: string): string {
  const [lo, hi] = [agent, counterpart].sort();
  return `${lo}::${hi}`;
}

/**
 * 空闲归档：将 messages.jsonl 移动到 archive/ 目录，
 * 然后从尾部保留近期消息（≤ 80% maxContextTokens）重建 messages.jsonl。
 *
 * 与 archiveAndRebuild 的区别：
 *   - archiveAndRebuild 在 postHook 中触发，有活跃 ctx，使用 ctx.history 重建
 *   - idleArchive 在定时器到期时触发，无活跃 ctx，从文件读取消息后重建
 *
 * 重建 messages.jsonl 的目的是保证前端刷新后仍能加载近期历史数据。
 */
export function idleArchive(agent: string, counterpart: string): void {
  const msgPath = resolveMessagePath(agent, counterpart);
  const archiveDir = resolveArchiveDir(agent, counterpart);

  if (!fs.existsSync(msgPath)) {
    return;
  }

  // 1. 在移动前读取所有消息
  let allMessages: PersistedMessage[] = [];
  try {
    const raw = fs.readFileSync(msgPath, 'utf-8').trim();
    if (raw) {
      allMessages = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as PersistedMessage; }
          catch { return null; }
        })
        .filter(Boolean) as PersistedMessage[];
    }
  } catch {
    // 读取失败则跳过重建
  }

  // 2. 计算归档编号
  let archiveCount = 0;
  if (fs.existsSync(archiveDir)) {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
    archiveCount = files.length;
  } else {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // 3. 移动当前 messages.jsonl 到归档
  const archivePath = path.join(archiveDir, `history_${archiveCount + 1}.jsonl`);
  fs.renameSync(msgPath, archivePath);

  const idleMinutes = Math.round(getIdleArchiveMs() / 60000);
  logger.info(
    `[agent-session] 空闲归档 (${idleMinutes} 分钟无活动)：` +
    `${msgPath} → ${archivePath}`
  );

  // 4. 从尾部截取近期消息（按 keepRecentRatio 比例）并重建 messages.jsonl
  if (allMessages.length > 0) {
    const maxTokens = cfg().maxContextTokens;
    const safeTarget = Math.ceil(maxTokens * cfg().keepRecentRatio);
    const truncated = truncatePersistedMessages(allMessages, safeTarget);

    const jsonl = truncated.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(msgPath, jsonl, 'utf-8');

    const dropped = allMessages.length - truncated.length;
    if (dropped > 0) {
      logger.info(
        `[agent-session] 空闲归档截断 ${dropped} 条早期消息，` +
        `保留 ${truncated.length} 条 (≤ ${safeTarget} tokens / ${maxTokens} 阈值)`
      );
    }
  }
}

/**
 * 从 PersistedMessage 数组尾部保留消息至指定 token 预算。
 * 与 archive.ts 中的 truncateTail 逻辑保持一致，
 * 保证不切割 tool-call ↔ tool-response 对。
 */
function truncatePersistedMessages(messages: PersistedMessage[], tokenBudget: number): PersistedMessage[] {
  let accumulated = 0;
  let splitIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    let msgTokens = estimateTokens(messages[i].content ?? '');
    const rc = messages[i].reasoning_content;
    if (rc) {
      msgTokens += estimateTokens(rc);
    }
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

/**
 * 重置指定会话对的空闲定时器。
 * 在每次 postHook 完成后调用，表示该会话刚刚有活动。
 */
export function resetIdleTimer(agent: string, counterpart: string): void {
  const key = pairKey(agent, counterpart);

  // 清除已有定时器
  const existing = timerMap.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // 设置新定时器
  const ms = getIdleArchiveMs();
  const timer = setTimeout(() => {
    timerMap.delete(key);
    idleArchive(agent, counterpart);
  }, ms);

  timerMap.set(key, timer);
}

/**
 * 清除所有定时器（扩展卸载时调用）。
 */
export function clearAllIdleTimers(): void {
  for (const [key, timer] of timerMap) {
    clearTimeout(timer);
  }
  timerMap.clear();
}
