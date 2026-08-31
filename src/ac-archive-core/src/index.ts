// ============================================================
// ac-archive-core —— 归档算法纯库（零 cordis 依赖）
//
// src svc/archive 的算法半边原样平移（服务编排半边归 ac-archive 行）：
//   · estimateMessagesTokens —— 会话消息估算（触发依据 = 会话消息估算，
//     而非 usage.total_tokens：系统提示固定开销不应触发归档——src 实测
//     大 AGENT.md 让任何 run 都"超阈值"的教训）
//   · truncateTail           —— 尾部预算截断（不拆 tool-call/response 对）
//   · dedupCutoff            —— 二次归档去重（message_id 精确 > role+content）
//   · splitForArchive        —— 归档分割（去重 + 截断的复合）
//
// 消息形状 = ac-session SessionRecord 的结构子集（"与 ac-session 共享格式"
// ——纯库零依赖，结构化兼容即可；type-import 由消费行自行完成）。
// 估算器复用 ac-text-budget（纯库依赖纯库，声明于 package.json）。
// ============================================================
import { estimateTokens } from 'ac-text-budget';

/** 归档相关预算（缺省值对齐 src DEFAULT_SESSION_CFG） */
export interface ArchiveBudgets {
  /** 会话上下文上限（token） */
  maxContextTokens: number;
  /** 超阈值比例（估算 > maxContextTokens × ratio 触发归档） */
  archiveTokenRatio: number;
  /** 归档后尾部保留比例（≤ maxContextTokens × ratio 的近期消息留在会话流） */
  keepRecentRatio: number;
}

export const DEFAULT_ARCHIVE_BUDGETS: ArchiveBudgets = {
  maxContextTokens: 1_000_000,
  archiveTokenRatio: 0.5,
  keepRecentRatio: 0.03,
};

/** 结构化消息（SessionRecord / LlmMessage 的公共子集） */
export interface ArchiveMessage {
  role: string;
  content?: string | null;
  message_id?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  /** 单调序号（M21 步骤 7 / D8：writer 分配；归档二次去重序号锚） */
  seq?: number;
}

/** 估算消息数组的 token 数（仅 content；历史 reasoning 不发送不占预算） */
export function estimateMessagesTokens(messages: Array<{ content?: string | null }>): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content ?? '');
  return total;
}

/** 归档阈值（估算超过即触发） */
export function thresholdOf(budgets: ArchiveBudgets): number {
  return Math.ceil(budgets.maxContextTokens * budgets.archiveTokenRatio);
}

/** 归档后尾部安全水位 */
export function keepBudgetOf(budgets: ArchiveBudgets): number {
  return Math.ceil(budgets.maxContextTokens * budgets.keepRecentRatio);
}

/**
 * 从尾部保留消息至指定 token 预算（src truncateMessagesByTokenBudget 语义
 * 原样：单条超预算 ×1.5 且已有累积时停——允许末条略超预算换完整语义单元）。
 */
export function truncateByTokenBudget<T extends { content?: string | null }>(
  messages: T[],
  tokenBudget: number,
): T[] {
  let accumulated = 0;
  let splitIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content ?? '');
    if (accumulated + msgTokens > tokenBudget * 1.5 && accumulated > 0) break;
    accumulated += msgTokens;
    splitIdx = i;
  }
  return messages.slice(Math.max(0, splitIdx));
}

/**
 * 调整分割点：落在 tool 消息上时回退到其配对 assistant(tool_calls) 之前
 * ——不拆 tool-call/response 对（src safeSplitIdx 语义）。
 * 【M15 对账标注】preview 会话记录当前为对话级（user/assistant 正文；
 * 工具对不落盘——ac-session 头注释），本函数现无工具对输入，属
 * 前向防御；会话记录粒度升级（工具对入账）后即刻生效，零改动。
 */
export function safeSplitIdx(messages: ArchiveMessage[], splitIdx: number): number {
  while (splitIdx > 0 && splitIdx < messages.length) {
    if (messages[splitIdx].role !== 'tool') break;
    let found = false;
    for (let j = splitIdx - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.role === 'tool') continue; // 同批工具结果，继续回找
      if (prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
        splitIdx = j;
        found = true;
      }
      break; // 入站边界（首个非 tool 消息）
    }
    if (!found) break;
  }
  return splitIdx;
}

/** 从尾部保留消息至预算（不拆 tool-call/response 对） */
export function truncateTail<T extends ArchiveMessage>(messages: T[], tokenBudget: number): T[] {
  const truncated = truncateByTokenBudget(messages, tokenBudget);
  const splitIdx = safeSplitIdx(messages, messages.length - truncated.length);
  return messages.slice(Math.max(0, splitIdx));
}

/**
 * 二次归档去重：在上次归档已覆盖的尾部消息处定位重叠分界。
 * 匹配优先级（M21 步骤 7 / D8）：seq 序号锚（O(1) 语义、免内容比对）
 * > message_id 精确匹配（content 为空的工具消息大量同形，role+content
 * 会错位——src 教训）> role+content 退化匹配。
 * @returns cutoff（0 = 无重叠；messages[..cutoff) 已被上次归档覆盖）
 */
export function dedupCutoff<T extends ArchiveMessage>(
  messages: T[],
  lastArchived: ArchiveMessage | null,
): number {
  if (!lastArchived) return 0;
  if (typeof lastArchived.seq === 'number') {
    const bySeq = messages.findIndex((m) => m.seq === lastArchived.seq);
    if (bySeq >= 0) return bySeq + 1;
  }
  if (lastArchived.message_id) {
    const byId = messages.findIndex((m) => m.message_id && m.message_id === lastArchived.message_id);
    if (byId >= 0) return byId + 1;
  }
  const targetContent = lastArchived.content ?? '';
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === lastArchived.role && messages[i].content === targetContent) return i + 1;
  }
  return 0;
}

/** 归档分割结果 */
export interface ArchiveSplit<T> {
  /** 写入本次归档段的区间（去重后、截断前） */
  archive: T[];
  /** 重建会话流的尾部保留 */
  keep: T[];
  /** 去重分界（messages[..cutoff) 已被上次归档覆盖） */
  cutoff: number;
  /** 截断分界（messages[truncStart..) 为尾部保留） */
  truncStart: number;
}

/**
 * 归档分割（去重 + 截断复合）：
 *   archive = messages[cutoff, truncStart)（被截掉且未被上次归档覆盖）
 *   keep    = messages[truncStart..]（尾部安全水位内，不拆工具对）
 */
export function splitForArchive<T extends ArchiveMessage>(
  messages: T[],
  budgets: ArchiveBudgets,
  lastArchived: ArchiveMessage | null,
): ArchiveSplit<T> {
  const cutoff = dedupCutoff(messages, lastArchived);
  const keep = truncateTail(messages, keepBudgetOf(budgets));
  const truncStart = messages.length - keep.length;
  return {
    archive: messages.slice(cutoff, Math.max(cutoff, truncStart)),
    keep,
    cutoff,
    truncStart,
  };
}
