// ============================================================
// src/plugins/builtin/hooks/run.ts —— 整次执行边界钩子（runStart/runEnd）
//
// 整次 run() 生命周期（可能多轮）的初始化装配与收尾：
//
//   runStart（chat.start 后）：
//     · build-system-prompt —— 构建 system prompt（角色/环境/术语/标签/指引/技能/存储/对话信息）
//     · load-history         —— 加载历史对话到 ctx.history
//   （记忆加载为独立钩子 builtin.load-memory，见 memory.ts makeLoadMemoryHook）
//   runEnd（chat.end 前）：
//     · idle-reset           —— 重置空闲归档计时器（旧 agent-session idle-timer）
//     · archive-session      —— 上下文超长归档（旧 agent-session archive）
//
// 说明：这些钩子需要 config/services，由 PluginHooks 工厂烘焙
// （(config, services) => PluginHooks）。
//
// 依赖方向：仅依赖 src/core + @agents/config + 本层 + Node 内置。
// ============================================================

import type { RunStartHook, RunEndHook, CurrentContext } from '@core/context';
import type { AgentConfig } from '@agents/config';
import type { PluginServices } from '../../types';
import { buildSystemPrompt } from './prompt';
import { loadHistory } from './session';
import { isGroupDialog, groupIdOfDialog } from '@agents/paths';

// ============================================================
// runStart：构建系统提示词（记忆加载拆至 memory.ts makeLoadMemoryHook）
// ============================================================

/**
 * runStart：构建 system prompt。
 * 旧 agent-prompt 完整装配（角色/环境/术语/标签/指引/技能/存储/对话信息）。
 * 记忆加载为独立钩子 builtin.load-memory（见 memory.ts makeLoadMemoryHook）。
 * 通过工厂烘焙拿到 config + services；sender/groupId 从 dialogId 推断。
 */
export function makeBuildSystemPromptHook(config: AgentConfig, services: PluginServices): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    const dialogId = ctx.dialogId;
    if (!dialogId) {
      // 无会话键（如子 Agent）：无需任何装配
      return;
    }

    const selfId = ctx.agentId ?? '';
    // 群组 trigger 由 dialogId 解析（group~<gid>~<aid>）；点到点缺省
    const groupId = isGroupDialog(dialogId) ? groupIdOfDialog(dialogId) : undefined;
    const sender = groupId ? selfId : (ctx.agentId ?? 'user');

    ctx.systemPrompt = buildSystemPrompt(config, services, {
      toolNames: Array.from(ctx.tools.keys()),
      sender,
      groupId,
    });
  };
}

// ============================================================
// runStart：加载历史对话
// ============================================================

/**
 * runStart：加载历史对话到 ctx.history。
 * 旧架构 preHook 第一步：加载 messages.jsonl → 填充 history。
 */
export function makeLoadHistoryHook(_config: AgentConfig): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    if (!ctx.dialogId) return;
    // 若装配层已加载（AgentAssembly.loadHistory）则复用；否则在此加载
    if (ctx.history && ctx.history.length > 0) return;
    ctx.history = loadHistory(ctx.dialogId);
  };
}

// ============================================================
// runEnd：空闲计时器（占位，L5 装配注入实现）
// ============================================================

/** runEnd：重置空闲归档计时器（旧 agent-session idle-timer；实现由 L5 注入） */
export function makeIdleResetHook(_config: AgentConfig, services: PluginServices): RunEndHook {
  return async (ctx: CurrentContext): Promise<void> => {
    const reset = (services as any).idleReset as ((dialogId: string) => void) | undefined;
    if (reset && ctx.dialogId) {
      try { reset(ctx.dialogId); } catch { /* ignore */ }
    }
  };
}

// ============================================================
// runEnd：上下文超长归档（占位，L5 装配注入实现）
// ============================================================

/** runEnd：上下文超长归档（旧 agent-session archive；实现由 L5 注入） */
export function makeArchiveSessionHook(_config: AgentConfig, services: PluginServices): RunEndHook {
  return async (ctx: CurrentContext, result): Promise<void> => {
    const archive = (services as any).archiveSession as ((dialogId: string, messages: unknown[]) => void) | undefined;
    if (archive && ctx.dialogId) {
      try { archive(ctx.dialogId, result.messages); } catch { /* ignore */ }
    }
  };
}
