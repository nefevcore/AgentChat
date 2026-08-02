// ============================================================
// agent-memory memory —— 长期记忆管理
//
// 记忆更新策略：混合方案（标记驱动 + 定时 trigger 智能审查）
//
//   postHook（机械层）：
//     agent-session 归档时写入 .memory_review_needed 标记。
//     不再累积摘要——Agent 通过 query_history 工具直接检索完整历史。
//
//   定时 trigger（智能层）：
//     Agent 配置每日凌晨定时任务，收到 trigger 后自行审查：
//       1. bash ls ./sessions/<自己的ID>/ 列出对话对象
//       2. 对存在 .memory_review_needed 标记的对象：
//          a. query_history 检索近期对话
//          b. read memory.md
//       3. 读取待办清单和笔记索引（read TODO.md, ls note/, read note/note_index）
//       4. 综合判断，更新 TODO.md 和 note/ 知识库
//       5. bash rm 清除 .memory_review_needed 标记
//
//   为什么这样设计？
//     · postHook 只写标记 — 零 LLM 调用，极简
//     · 定时 trigger 发挥 Agent 智能 — query_history 获取完整上下文
//     · memory.md 仅在每日审查时变更 → system prompt 极度稳定 → 缓存命中率极高
//     · Agent 自主决定记什么、忘什么
//
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../../../utils/logger';
import { estimateTokens } from '../../../../utils/tokens';
import { AgentContext } from '@core/types';
import { resolveMemoryPath, resolveMemoryUpdateMarkerPath, resolveMemoryReviewMarkerPath } from './paths';

// ============================================================
// 长期记忆 —— memory.md 读写
// ============================================================

export interface MemoryLoadOptions {
  /** 注入系统提示词的记忆 token 预算。超出时截断（保留头部），Agent 可用 read 读取全量。0/缺省 = 不限制 */
  budgetTokens?: number;
}

/**
 * 加载 Agent 对 counterpart 的长期记忆。
 * 返回 memory.md 的内容（按预算截断），不存在时返回 null。
 */
export function loadMemory(agent: string, counterpart: string, options?: MemoryLoadOptions): string | null {
  const filePath = resolveMemoryPath(agent, counterpart);
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;

    const budget = options?.budgetTokens;
    if (budget && budget > 0) {
      const fullTokens = estimateTokens(content);
      if (fullTokens > budget) {
        const truncated = truncateMemory(content, budget, agent, counterpart);
        logger.info(`[agent-memory] 记忆截断 ${agent}/${counterpart}: ${fullTokens} → ${budget} tok`);
        return truncated;
      }
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * 按 token 预算截断记忆：保留头部（人设/偏好/方向），末尾追加提示。
 * 完整记忆仍在文件系统，Agent 可通过 read 读取（storage block 已给出路径）。
 */
export function truncateMemory(content: string, budgetTokens: number, agent: string, counterpart: string): string {
  const fullTokens = estimateTokens(content);
  if (fullTokens <= budgetTokens) return content;

  const lines = content.split('\n');
  const kept: string[] = [];
  let tokens = 0;
  // 预留截断提示的空间（提示文本自身约 30-40 token）
  const headBudget = Math.max(budgetTokens - 40, 40);

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > headBudget) break;
    kept.push(line);
    tokens += lineTokens;
  }
  if (kept.length === 0 && lines.length > 0) {
    kept.push(lines[0]);
  }

  const notice = `\n> [记忆已截断] 以上仅前部（预算 ${budgetTokens} token，全量 ${estimateTokens(content)}）。完整内容见 \`./sessions/${agent}/${counterpart}/memory.md\`，需要时用 read 读取。`;
  return kept.join('\n') + notice;
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
// 记忆审查标记（混合方案：postHook 写标记，定时 trigger 消费）
// ============================================================

/**
 * 写入记忆审查标记（不再包含 pending 计数——Agent 通过 query_history 自行检索）。
 * agent-session 归档时由 postHook 或 WebUI 手动归档调用。
 */
export function markMemoryReviewNeeded(agent: string, counterpart: string): void {
  const filePath = resolveMemoryReviewMarkerPath(agent, counterpart);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const info = JSON.stringify({
    agent,
    counterpart,
    markedAt: new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(filePath, info, 'utf-8');
  logger.info(`[agent-memory] 已写入审查标记: ${agent}/${counterpart}`);
}

/**
 * 检查并消费记忆审查标记（存在则返回 true 并删除标记）。
 */
export function consumeMemoryReviewMarker(agent: string, counterpart: string): boolean {
  const filePath = resolveMemoryReviewMarkerPath(agent, counterpart);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ============================================================
// 记忆更新入口（postHook）
// ============================================================

/**
 * postHook 调用：检测归档标记 → 写入审查标记。
 *
 * 不再累积摘要——Agent 在定时 review 时通过 query_history 直接检索完整历史。
 */
export async function updateMemory(
  agent: string,
  counterpart: string,
  _ctx: AgentContext,
  _response: string,
): Promise<void> {
  const needsUpdate = consumeUpdateMarker(agent, counterpart);
  if (!needsUpdate) return;

  markMemoryReviewNeeded(agent, counterpart);
  logger.info(`[agent-memory] 归档触发 → 已写入审查标记: ${agent}/${counterpart}`);
}

// ============================================================
// 强制记忆审查标记（WebUI 手动归档时调用）
// ============================================================

export function forceUpdateMemory(agent: string, counterpart: string): void {
  consumeUpdateMarker(agent, counterpart);
  consumeMemoryReviewMarker(agent, counterpart);

  markMemoryReviewNeeded(agent, counterpart);
  logger.info(`[agent-memory] 手动归档 → 已写入审查标记: ${agent}/${counterpart}`);
}
