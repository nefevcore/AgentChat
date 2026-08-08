// ============================================================
// src/plugins/builtin/hooks/index.ts —— 内置钩子聚合（L3，工厂形式）
//
// 工厂：builtinHooks(config, services) => PluginHooks —— per-Agent 烘焙
// （runStart 的 build-system-prompt / open-mcp / load-history 需要 config/services）。
//
// 生命周期分工（与 L1 run/turn 边界对齐）：
//   runStart（整次执行开始）：
//     · builtin.open-mcp            —— 启动 MCP 并注册工具
//     · builtin.build-system-prompt —— 构建 system prompt（角色/标签/指引/技能/存储/对话信息；
//                                      含当前时间，不再单独 inject-time）
//     · builtin.load-memory         —— 记忆加载（独立钩子，与 build-system-prompt 解耦）
//     · builtin.load-history        —— 加载历史对话
//   turnStart（每轮回合开始）：
//     · （工具清单/时间已由 build-system-prompt 与 tool 定义承载，无需每轮注入）
//   toolExecutionStart（工具执行前）：
//     · builtin.security-check      —— 安全检查（拦截敏感工具：档案权限/危险路径）
//   toolExecutionEnd（工具执行后）：
//     · builtin.log-tool            —— 轻量日志
//   runEnd（整次执行结束）：
//     · builtin.save-session        —— 会话持久化（整次唯一写盘，避免多轮重复）
//     · builtin.update-memory       —— 记忆审查标记（会话级，标记驱动）
//     · builtin.idle-reset          —— 重置空闲归档计时器
//     · builtin.archive-session     —— 上下文超长归档
//     · builtin.log-usage           —— Token 用量记录（usage 为整次 run 累计）
//
// 依赖方向：仅依赖 src/core + 本层各领域文件 + 本层 types。
// ============================================================

import { createLogger } from '@core/logger';
import type { PluginHooks, PluginServices } from '../../types';
import type { AgentConfig } from '@agents/config';
import { updateMemory, makeLoadMemoryHook } from './memory';
import { saveSession, logRunUsage } from './session';
import { makeOpenMCPHook } from './mcp';
import { makeBuildSystemPromptHook, makeLoadHistoryHook, makeIdleResetHook, makeArchiveSessionHook } from './run';
import { makeSecurityStartHook } from './security';

const log = createLogger('[builtin]');

/** 内置钩子工厂（per-Agent 烘焙 config + services） */
export function builtinHooks(config: AgentConfig, services: PluginServices): PluginHooks {
  return {
    // ---- 整次执行开始：初始化装配 ----
    runStart: {
      'builtin.open-mcp': makeOpenMCPHook(config),
      'builtin.build-system-prompt': makeBuildSystemPromptHook(config, services),
      'builtin.load-memory': makeLoadMemoryHook(config),
      'builtin.load-history': makeLoadHistoryHook(config),
    },

    // ---- 工具执行前：安全检查（拦截敏感工具）----
    toolExecutionStart: {
      'builtin.security-check': makeSecurityStartHook(services.agentsDir ?? '', config.agent_id),
    },

    // ---- 工具执行后 ----
    toolExecutionEnd: {
      'builtin.log-tool': async (outcome) => {
        log.info(`工具 ${outcome.toolName} 完成，耗时 ${outcome.durationMs ?? '?'}ms${outcome.error ? '（异常）' : ''}`);
      },
    },

    // ---- 整次执行结束：会话收尾（持久化/记忆/归档/用量）----
    runEnd: {
      'builtin.save-session': saveSession,
      'builtin.update-memory': updateMemory,
      'builtin.idle-reset': makeIdleResetHook(config, services),
      'builtin.archive-session': makeArchiveSessionHook(config, services),
      'builtin.log-usage': logRunUsage,
    },
  };
}
