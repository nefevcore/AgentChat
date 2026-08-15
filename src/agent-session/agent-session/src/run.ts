// ============================================================
// src/plugins/builtin/hooks/run.ts —— 整次执行边界钩子（runStart/runEnd）
//
// 整次 run() 生命周期（可能多轮）的初始化装配与收尾：
//
//   runStart（chat.start 后）：
//     · build-system-prompt —— 构建 system prompt（角色/环境/术语/标签/指引/技能/存储/对话信息）
//     · load-history         —— 加载历史对话到 ctx.history
//   （记忆加载为独立钩子 agent-memory.load-memory，见 memory.ts makeLoadMemoryHook）
//   runEnd（chat.end 前）：
//     · idle-reset           —— 重置空闲归档计时器（旧 agent-session idle-timer）
//     · archive-session      —— 上下文超长归档（旧 agent-session archive）
//
// 说明：这些钩子需要 config/services，由 PluginHooks 工厂烘焙
// （(config, services) => PluginHooks）。
//
// 依赖方向：仅依赖 src/core + @agents/config + 本层 + Node 内置。
// ============================================================

import type { RunStartHook, RunEndHook, CurrentContext } from '@agentchat/agent-loop';
import type { AgentConfig } from '@agentchat/agent-config';
import { getNamespaceConfig } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import { buildSystemPrompt } from '@agentchat/agent-prompt';
import { loadHistory, loadGroupHistory } from './session';
import { isGroupDialog, groupIdOfDialog } from '@agentchat/agents';
import { META_ARCHIVE_REVIEW, NS_AGENT_SESSION } from '@agentchat/toolkit';
import type { ConfigField } from '@agentchat/toolkit';

// ============================================================
// 会话上下文命名空间 Schema（agent.session；archive-session / load-history 钩子消费，
// PluginDefinition.configs 声明，UI 弹窗内编辑该命名空间配置）
// ============================================================

export const SESSION_CONFIG_SCHEMA: ConfigField[] = [
  { name: 'maxContextTokens', label: '上下文 Token 上限', description: '会话上下文最大 Token 数', type: 'number', default: 1000000 },
  { name: 'keepRecentRatio', label: '保留近期比例', description: '截断时保留最近消息的比例 (0-1)', type: 'ratio', min: 0, max: 1, step: 0.01, display: 'percent', default: 0.03 },
  { name: 'summaryPreviewLen', label: '摘要预览长度', description: '会话摘要预览字符数', type: 'number', default: 4000 },
  { name: 'idleArchiveSec', label: '空闲归档秒数', description: '空闲多少秒后自动归档', type: 'number', default: 14400 },
  { name: 'messageQueryDefaultLimit', label: '消息查询默认条数', description: '历史消息查询默认返回条数', type: 'number', default: 20 },
  { name: 'archiveTokenRatio', label: '归档触发比例', description: '超出上下文预算比例时触发归档 (0-1)', type: 'ratio', min: 0, max: 1, step: 0.05, display: 'percent', default: 0.5 },
];

// ============================================================
// runStart：构建系统提示词（记忆加载拆至 memory.ts makeLoadMemoryHook）
// ============================================================

/**
 * runStart：构建 system prompt。
 * 旧 agent-prompt 完整装配（角色/环境/术语/标签/指引/技能/存储/对话信息）。
 * 记忆加载为独立钩子 agent-memory.load-memory（见 memory.ts makeLoadMemoryHook）。
 * 通过工厂烘焙拿到 config + services；sender/groupId 从 dialogId 推断。
 */
// ============================================================
// runStart：加载历史对话
// ============================================================

/** 群聊单次加载上限默认值（对齐旧 agent-session groupLoadLimitTokens 默认 30000） */
export const DEFAULT_GROUP_LOAD_LIMIT_TOKENS = 30000;

/**
 * runStart：加载历史对话到 ctx.history。
 *   · 群聊：注入未归档群聊历史（恢复旧架构 preHook 的 loadGroupHistory 行为）——
 *     装配层 AgentAssembly.loadHistory 对群聊返回空，此处经 loadGroupHistory 完整注入：
 *     <msg> 标签格式化（含名称/群名映射）+ 合并相邻发言 + 超限截断（groupLoadLimitTokens）。
 *   · 1v1：若装配层已加载则复用；否则在此加载 messages.jsonl。
 */
export function makeLoadHistoryHook(config: AgentConfig, services: ToolContext): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    if (!ctx.dialogId) return;

    // 群聊：由本钩子完整加载（覆盖装配层的空 history）
    if (isGroupDialog(ctx.dialogId)) {
      const registry = services.router?.getRegistry();
      const gm = services.router?.getGroupManager();
      const ns = getNamespaceConfig(config, NS_AGENT_SESSION);
      const limit = (typeof ns.groupLoadLimitTokens === 'number' && ns.groupLoadLimitTokens > 0)
        ? ns.groupLoadLimitTokens
        : DEFAULT_GROUP_LOAD_LIMIT_TOKENS;
      ctx.history = loadGroupHistory(groupIdOfDialog(ctx.dialogId), ctx.agentId ?? config.agent_id, {
        getName: registry ? (id: string) => registry.getAgentName(id) : undefined,
        getGroupName: gm ? (gid: string) => gm.getGroup(gid)?.name : undefined,
        groupLoadLimitTokens: limit,
      });
      return;
    }

    // 1v1：若装配层已加载（AgentAssembly.loadHistory）则复用；否则在此加载
    if (ctx.history && ctx.history.length > 0) return;
    ctx.history = loadHistory(ctx.dialogId);
  };
}

// ============================================================
// runEnd：空闲计时器（占位，L5 装配注入实现）
// ============================================================

/** runEnd：重置空闲归档计时器（旧 agent-session idle-timer；实现由 L5 注入 ArchiveService） */
export function makeIdleResetHook(_config: AgentConfig, services: ToolContext): RunEndHook {
  return async (ctx: CurrentContext): Promise<void> => {
    // 整理轮不重置空闲计时器（仅标记完成；空闲归档由主对话驱动）
    if (ctx.meta?.[META_ARCHIVE_REVIEW]) return;
    const reset = (services as any).idleReset as ((dialogId: string, selfId?: string) => void) | undefined;
    if (reset && ctx.dialogId) {
      try { reset(ctx.dialogId, ctx.agentId); } catch { /* ignore */ }
    }
  };
}

// ============================================================
// runEnd：上下文超长归档（占位，L5 装配注入实现）
// ============================================================

/**
 * runEnd：上下文超长归档（旧 agent-session archive；实现由 L5 注入 ArchiveService）。
 *
 * 统一入口（handleRunEnd）：
 *   · meta['archive-review']（整理轮）→ 写 done 标记 + 检查全部完成 → archiveAndRebuild
 *   · 否则 → 超阈值检测（API 实际 token / 估算兜底）→ requestArchive（写 pending + 触发整理轮）
 * 群聊由 save-session 周归档承载，不参与 1:1 编排。
 */
export function makeArchiveSessionHook(_config: AgentConfig, services: ToolContext): RunEndHook {
  return async (ctx: CurrentContext, result): Promise<void> => {
    const archive = (services as any).archiveSession as
      | ((ctx: CurrentContext, result: import('@agentchat/agent-loop').RunResult) => Promise<void> | void)
      | undefined;
    if (archive && ctx.dialogId) {
      try { await archive(ctx, result); } catch { /* ignore */ }
    }
  };
}
