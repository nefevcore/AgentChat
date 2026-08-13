// ============================================================
// src/plugins/builtin/hooks/memory.ts —— 长期记忆钩子（L3，照搬旧 agent-memory）
//
// 记忆按对话对（dialogId）方向敏感存取，文件 <ws>/files/<selfId>/memory/<counterpart>.memory.md
// （1v1 counterpart=对方 id；群聊=group~<gid>；每对对话方一份独立记忆）：
//
//   · runStart 加载（load-memory）：
//       加载 memory.md 直接拼接到 system prompt 末尾（无标签、无去重）。
//       超出 token 预算时保留头部并附截断提示，完整记忆可用 read 读取。
//
//   记忆更新由 [归档整理] 整理轮统一完成（写 memory.md）；不再维护
//   .memory_update_needed / .memory_review_needed 审查标记（2026-08-08 移除）。
//
// 依赖方向：仅依赖 src/core + Node fs/path + 本层 shared + paths。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { LLMRequestMessage } from '@core/types';
import type { CurrentContext, RunStartHook } from '@core/context';
import { createLogger } from '@core/logger';
import { getNamespaceConfig } from '@agents/config';
import { NS_AGENT_MEMORY } from '../namespaces';
import type { AgentConfig } from '@agents/config';
import type { ConfigField } from '../../schema';
import { workspaceRoot, estimateTokens } from '../tools/shared';
import { memoryFileOf, counterpartOfDialog } from '../paths';

const log = createLogger('[builtin:memory]');

// ============================================================
// 路径解析（集中管理：files/<selfId>/memory/）
// ============================================================

/** 记忆文件路径（显式 selfId；1v1 排序共享会话键后不可反推） */
function memoryFile(dialogId: string, selfId: string): string {
  return memoryFileOf(dialogId, selfId);
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
// runStart 加载（独立钩子：load-memory，与 build-system-prompt 解耦）
// ============================================================

/** 记忆加载预算默认值（照搬旧 meta.ts 默认 10000：缓存 token 便宜，一次性加载减少 Agent 频繁调工具查记忆） */
export const DEFAULT_MEMORY_BUDGET_TOKENS = 10000;

/** load-memory 钩子配置命名空间 Schema（agent.memory；PluginDefinition.configs 声明） */
export const MEMORY_CONFIG_SCHEMA: ConfigField[] = [
  { name: 'memoryBudgetTokens', label: '记忆预算 Token', description: '记忆模块可用 Token 预算', type: 'number', default: 10000 },
];

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


