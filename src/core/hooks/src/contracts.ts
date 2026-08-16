// ============================================================
// @agentchat/hooks/src/contracts.ts —— 钩子契约（PluginHooks）
//
// 钩子函数签名已迁至 @agentchat/contracts（零运行时依赖契约包）。
// 本文件 re-export 保持旧 import 兼容。
//
// 铁律：仅类型引用。
// ============================================================

import type {
  FallbackHook,
  RunEndHook,
  RunStartHook,
  StepEndHook,
  StepStartHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
} from '@agentchat/contracts';

export type {
  FallbackHook,
  RunEndHook,
  RunStartHook,
  StepEndHook,
  StepStartHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
} from '@agentchat/contracts';

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
  /** 步骤开始钩子（L1 stepStartHook ↔ chat.step.start） */
  stepStart?: Record<string, StepStartHook>;
  /** 步骤结束钩子（L1 stepEndHook ↔ chat.step.end） */
  stepEnd?: Record<string, StepEndHook>;
  /** 工具执行前钩子（L1 toolExecutionStartHook ↔ chat.tool_execution.start） */
  toolExecutionStart?: Record<string, ToolExecutionStartHook>;
  /** 工具执行后钩子（L1 toolExecutionEndHook ↔ chat.tool_execution.end）：可观察、可返回替换内容 */
  toolExecutionEnd?: Record<string, ToolExecutionEndHook>;
  /** 兜底钩子（L1 fallbackHook，失败路径兜底） */
  fallback?: Record<string, FallbackHook>;
}

export type { ToolContext } from '@agentchat/tools';
