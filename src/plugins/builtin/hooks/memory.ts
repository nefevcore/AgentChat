// ============================================================
// src/plugins/builtin/hooks/memory.ts —— 长期记忆钩子（L3，照搬旧 agent-memory）
//
// 记忆按对话对（dialogId）方向敏感存取，文件 <ws>/sessions/<dialogId>/memory.md
// （与 hooks/session 的 messages.jsonl 同目录；旧架构为嵌套 sessions/<agent>/<counterpart>/，
//   新架构平铺为 dialogId，本质同构——每对对话方一份独立记忆）：
//
//   · runStart 加载（load-memory）：
//       加载 memory.md 直接拼接到 system prompt 末尾（无标签、无去重）。
//       超出 token 预算时保留头部并附截断提示，完整记忆可用 read 读取。
//   · runEnd 标记（update-memory）：
//       检测归档更新标记（.memory_update_needed）→ 有则写记忆审查标记
//       （.memory_review_needed）。不直接修改 memory.md —— 零 LLM 调用，
//       由 Agent 每日定时 trigger 自行审查重写（智能层），照搬旧混合方案。
//
// 路径规范（集中管理）：
//   <ws>/files/<selfId>/memory/<counterpart>.memory.md      （1v1 counterpart=对方 id；群聊=group~<gid>）
//   <ws>/files/<selfId>/memory/<counterpart>.memory_update_needed
//   <ws>/files/<selfId>/memory/<counterpart>.memory_review_needed
//
// 依赖方向：仅依赖 src/core + Node fs/path + 本层 shared + paths。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { LLMRequestMessage, RunResult } from '@core/types';
import type { CurrentContext, RunStartHook } from '@core/context';
import { createLogger } from '@core/logger';
import { getNamespaceConfig } from '@agents/config';
import { NS_AGENT_MEMORY } from '../namespaces';
import type { AgentConfig } from '@agents/config';
import { workspaceRoot, estimateTokens } from '../tools/shared';
import { memoryFileOf, memoryMarkerFile, counterpartOfDialog } from '../paths';

const log = createLogger('[builtin:memory]');

// ============================================================
// 路径解析（集中管理：files/<selfId>/memory/）
// ============================================================

/** 记忆文件路径（显式 selfId；1v1 排序共享会话键后不可反推） */
function memoryFile(dialogId: string, selfId: string): string {
  return memoryFileOf(dialogId, selfId);
}

/** 归档更新标记路径 */
function updateMarkerFile(dialogId: string, selfId: string): string {
  return memoryMarkerFile(selfId, counterpartOfDialog(dialogId, selfId), 'update');
}

/** 记忆审查标记路径 */
function reviewMarkerFile(dialogId: string, selfId: string): string {
  return memoryMarkerFile(selfId, counterpartOfDialog(dialogId, selfId), 'review');
}

// ============================================================
// memory.md 读写（照搬旧 memory.ts loadMemory / truncateMemory）
// ============================================================

export interface MemoryLoadOptions {
  /** 注入 system prompt 的记忆 token 预算。超出时截断（保留头部），Agent 可用 read 读取全量。0/缺省 = 不限制 */
  budgetTokens?: number;
}

/**
 * 加载对话对的长期记忆。
 * 返回 memory.md 的内容（按预算截断），不存在/为空时返回 null。
 * budgetTokens：>0 时按预算截断；0 或缺省 = 不限制（返回全量）。
 */
export function loadMemory(dialogId: string, selfId: string, options?: MemoryLoadOptions): string | null {
  const filePath = memoryFile(dialogId, selfId);
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;

    const budget = options?.budgetTokens;
    // 仅当 budget > 0 时按预算截断；0/缺省 = 不限制
    if (typeof budget === 'number' && budget > 0) {
      const fullTokens = estimateTokens(content);
      if (fullTokens > budget) {
        const truncated = truncateMemory(content, budget, dialogId, selfId);
        log.info(`[builtin:memory] 记忆截断 ${dialogId}: ${fullTokens} → ${budget} tok`);
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
 * 完整记忆仍在文件系统，Agent 可通过 read 读取（提示已给出路径）。
 */
export function truncateMemory(content: string, budgetTokens: number, dialogId: string, selfId: string): string {
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

  const notice = `\n> [记忆已截断] 以上仅前部（预算 ${budgetTokens} token，全量 ${fullTokens}）。完整内容见 \`./files/${selfId}/memory/${counterpartOfDialog(dialogId, selfId)}.memory.md\`，需要时用 read 读取。`;
  return kept.join('\n') + notice;
}

// ============================================================
// 标记驱动（照搬旧 memory.ts：mark/consume + 混合方案）
// ============================================================

/** agent-session 归档后写入此标记，agent-memory 据此触发记忆重写流程 */
export function markMemoryUpdateNeeded(dialogId: string, selfId: string): void {
  const filePath = updateMarkerFile(dialogId, selfId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, '', 'utf-8');
}

/** 检查并消费归档更新标记（存在则返回 true 并删除标记） */
function consumeUpdateMarker(dialogId: string, selfId: string): boolean {
  const filePath = updateMarkerFile(dialogId, selfId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 写入记忆审查标记（不再包含 pending 计数——Agent 通过 query_history 自行检索）。
 * 由 runEnd 的 update-memory 钩子或 WebUI 手动归档调用。
 */
export function markMemoryReviewNeeded(dialogId: string, selfId: string): void {
  const filePath = reviewMarkerFile(dialogId, selfId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const info = JSON.stringify({
    dialogId,
    markedAt: new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(filePath, info, 'utf-8');
  log.info(`[builtin:memory] 已写入审查标记: ${dialogId}`);
}

/**
 * 检查并消费记忆审查标记（存在则返回 true 并删除标记）。
 * Agent 定时 trigger 审查完成后调用。
 */
export function consumeMemoryReviewMarker(dialogId: string, selfId: string): boolean {
  const filePath = reviewMarkerFile(dialogId, selfId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ============================================================
// runStart 加载（独立钩子：load-memory，与 build-system-prompt 解耦）
// ============================================================

/** 记忆加载预算默认值（照搬旧 meta.ts 默认 10000：缓存 token 便宜，一次性加载减少 Agent 频繁调工具查记忆） */
export const DEFAULT_MEMORY_BUDGET_TOKENS = 10000;

/**
 * runStart 钩子工厂：加载记忆并拼接到 system prompt 末尾。
 * 与旧 preHook 等价——在 build-system-prompt 装配出的 ctx.systemPrompt 末尾追加 `\n\n<memory>`。
 * 预算读取 agent.memory.memoryBudgetTokens（缺省 DEFAULT_MEMORY_BUDGET_TOKENS；0 = 不截断）。
 * 工厂烘焙：config 在 PluginHooks 工厂中传入（读取 NS_AGENT_MEMORY 命名空间）。
 */
export function makeLoadMemoryHook(config: AgentConfig): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    const dialogId = ctx.dialogId;
    if (!dialogId) return;

    const ns = getNamespaceConfig(config, NS_AGENT_MEMORY);
    const budgetTokens = typeof ns.memoryBudgetTokens === 'number' ? ns.memoryBudgetTokens : DEFAULT_MEMORY_BUDGET_TOKENS;
    const memory = loadMemory(dialogId, ctx.agentId ?? config.agent_id, { budgetTokens });
    if (memory) {
      ctx.systemPrompt = `${ctx.systemPrompt}\n\n${memory}`;
    }
  };
}

/**
 * 回合开始：加载记忆并拼接到 messages 数组的 system 消息末尾。
 * 与旧 preHook 等价——直接在其 content 末尾追加 `\n\n<memory>`（无标签、无去重）。
 */
export async function loadMemoryToMessages(ctx: CurrentContext, messages: LLMRequestMessage[]): Promise<void> {
  const dialogId = ctx.dialogId;
  if (!dialogId) return;

  const memory = loadMemory(dialogId, ctx.agentId ?? '', { budgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS });
  if (!memory) return;

  const sys = messages.find(m => m.role === 'system');
  if (sys && typeof sys.content === 'string') {
    sys.content = `${sys.content}\n\n${memory}`;
  }
}

// ============================================================
// runEnd 标记（照搬旧 postHook：只写标记，不直接改 memory.md）
// ============================================================

/**
 * 整次执行结束：检测归档更新标记 → 写入审查标记。
 * 标记驱动、与轮次无关 —— 放 runEnd 一次消费即可（turnEnd 每轮重复尝试无意义）。
 * 不再累积摘要——Agent 在定时 review 时通过 query_history 直接检索完整历史，
 * 自行决定更新 memory.md（零 LLM 调用，照搬旧混合方案）。
 */
export async function updateMemory(
  ctx: CurrentContext,
  _result: RunResult,
): Promise<void> {
  const dialogId = ctx.dialogId;
  if (!dialogId) return;
  const selfId = ctx.agentId ?? '';

  const needsUpdate = consumeUpdateMarker(dialogId, selfId);
  if (!needsUpdate) return;

  markMemoryReviewNeeded(dialogId, selfId);
}

// ============================================================
// 强制记忆审查标记（WebUI 手动归档时调用）
// ============================================================

export function forceUpdateMemory(dialogId: string, selfId: string): void {
  consumeUpdateMarker(dialogId, selfId);
  consumeMemoryReviewMarker(dialogId, selfId);

  markMemoryReviewNeeded(dialogId, selfId);
}
