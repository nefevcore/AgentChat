// ============================================================
// @agentchat/hooks/src/contracts.ts —— 钩子契约（PluginHooks）
//
// 迁移自 @agentchat/ext/src/contracts.ts（ext → hooks 更名）。
// 钩子工厂签名：(config: AgentConfig, services: ToolContext) => PluginHooks。
// cordis 化后各钩子将逐步对齐事件语义（runStart/runEnd → serial/waterfall），
// 当前保持有名映射形态（按名引用，PluginRegistry.resolveHooks 语义兼容）。
//
// 铁律：仅类型引用。
// ============================================================

import type {
  FallbackHook,
  RunEndHook,
  RunStartHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
  TurnEndHook,
  TurnStartHook,
} from '@agentchat/agent-loop';

export type {
  RunStartHook, RunEndHook, TurnStartHook, TurnEndHook,
  ToolExecutionStartHook, ToolExecutionEndHook, FallbackHook,
} from '@agentchat/agent-loop';

/**
 * 各类钩子的有名映射：钩子名 → 实现。
 * 与 L1 CurrentContext 各类钩子一一对齐，AgentConfig.hooks.{runStart:[...]}
 * 按名引用，由装配层按名收集成数组。
 */
export interface PluginHooks {
  /** 整次执行开始钩子（L1 runStartHook ↔ chat.start） */
  runStart?: Record<string, RunStartHook>;
  /** 整次执行结束钩子（L1 runEndHook ↔ chat.end） */
  runEnd?: Record<string, RunEndHook>;
  /** 回合开始钩子（L1 turnStartHook ↔ chat.turn.start） */
  turnStart?: Record<string, TurnStartHook>;
  /** 回合结束钩子（L1 turnEndHook ↔ chat.turn.end） */
  turnEnd?: Record<string, TurnEndHook>;
  /** 工具执行前钩子（L1 toolExecutionStartHook ↔ chat.tool_execution.start） */
  toolExecutionStart?: Record<string, ToolExecutionStartHook>;
  /** 工具执行后钩子（L1 toolExecutionEndHook ↔ chat.tool_execution.end） */
  toolExecutionEnd?: Record<string, ToolExecutionEndHook>;
  /** 兜底钩子（L1 fallbackHook，失败路径兜底） */
  fallback?: Record<string, FallbackHook>;
}

export type { ToolContext } from '@agentchat/tools';
