// ============================================================
// src/plugins/types.ts —— 插件契约（L3 扩展层）
//
// 统一为四要素：
//   · meta     —— 插件元数据（对应 plugin.json）
//   · tools    —— 工具（数组=共享 / 工厂=按 Agent 配置烘焙）
//   · hooks    —— 各类钩子的有名映射（配合 AgentConfig.plugins 按名引用）
//   · services —— 对外暴露的服务（服务名 → 工厂；L5 useService 惰性装载）
//
// 依赖方向：仅依赖 src/core 与本层（相对导入）+ @agents/config 类型（L3→L2 单向）。
// ============================================================

import type {
  FallbackHook,
  RunEndHook,
  RunStartHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
  TurnEndHook,
  TurnStartHook,
} from '@core/context';
import type { Tool } from '@core/types';
import type { AgentConfig } from '@agents/config';
import type { AgentRouter } from '@agents/router';

// ============================================================
// 插件元数据
// ============================================================

/** 插件元数据（plugin.json 对应） */
export interface PluginMeta {
  /** 插件唯一标识 */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description?: string;
}

// ============================================================
// 钩子声明
// ============================================================

/**
 * 各类钩子的有名映射：钩子名 → 实现。
 * 与 L1 CurrentContext 各类钩子一一对齐，AgentConfig.plugins.{runStart:[...]}
 * 按名引用，PluginRegistry.resolveHooks 按名收集成数组。
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

/**
 * 钩子声明：
 *   · PluginHooks      —— 静态钩子映射（跨 Agent 复用实现）
 *   · (config, services) => PluginHooks —— 工厂：按 Agent 配置 + 运行时服务烘焙
 *     （runStart 的 build-system-prompt / load-history / open-mcp 需要 config/services）
 */
export type PluginHookDef = PluginHooks | ((config: AgentConfig, services: PluginServices) => PluginHooks);

// ============================================================
// 工具声明
// ============================================================

/**
 * 工具声明：
 *   · Tool[]        —— 简单共享工具（无 per-Agent 配置/服务依赖，跨 Agent 复用实例）
 *   · (config, services) => Tool[] —— 工厂：按 Agent 配置 + 运行时服务生成
 *     （per-Agent 烘焙：沙箱 security.allowedPaths / tool.* 命名空间 / 身份 from=config.agent_id
 *      替代旧拦截器；services.router 供 send_agent 等工具访问路由）
 */
export type PluginTools = Tool[] | ((config: AgentConfig, services: PluginServices) => Tool[]);

/**
 * 插件运行时服务（L5 装配时注入 PluginRegistry；工具经工厂第二个参数访问）。
 * 替代旧架构的 getAppState() 全局单例。
 */
export interface PluginServices {
  /** 消息路由（send_agent / send_group / list_agents / list_groups 等用） */
  router?: AgentRouter;
  /** 当前 Agent 的 LLM 实例（spawn_subagent 子 Agent 共享；L5 装配注入） */
  llm?: import('@core/types').LLMProvider;
  /** 当前 Agent 的工具集（spawn_subagent 子 Agent 受控工具集筛选；L5 装配注入） */
  tools?: Map<string, import('@core/types').Tool>;
  /** 定时任务管理器（set_timer / list_timers / disable_timer 用；mod 内服务，L5 装配注入） */
  timer?: import('./builtin/services/timer').TimerManager;
  /** 子 Agent 管理器（spawn_subagent 等用；mod 内服务，L5 装配注入） */
  subAgent?: import('./builtin/services/subagent').SubAgentManager;
  /** 用户交互桥（ask_questions 用；L4 services 提供，L5 装配注入） */
  interaction?: {
    askQuestions(opts: {
      agentId: string;
      convKey: string;
      questions: Array<{ question: string; options: string[] }>;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<string[]>;
  };
  /** 搜索 provider 池（web_search 用；L5 装配注入全局配置的 searchProviders） */
  searchProviders?: Record<string, Record<string, unknown>>;
  /** Agent 配置目录（agent-prompt 装配 AGENT.md/SYSTEM.md/skills 用；L5 装配注入） */
  agentsDir?: string;
}

// ============================================================
// 插件定义（单入口 default 导出）
// ============================================================

/**
 * 服务装配上下文（L5 bootstrap 提供，useService 装载时传给服务工厂）。
 * 承载服务创建所需的全局配置（工作区/Agent 目录/时区/全局配置）。
 */
export interface PluginServiceContext {
  /** 工作区根（services/timer 的 timer-state.json 所在） */
  workspaceDir: string;
  /** Agent 配置目录（services/timer 扫描 config.json 的 timer 命名空间） */
  agentsDir: string;
  /** 时区（默认 Asia/Shanghai） */
  timezone?: string;
  /** 其他全局配置（插件自定义） */
  [key: string]: unknown;
}

/**
 * 插件对外暴露的服务：服务名 → 工厂（ctx 装配上下文 → 服务实例）。
 * L5 经 PluginRegistry.useService(name) 惰性装载并缓存。
 */
export type PluginServicesDef = Record<string, (ctx: PluginServiceContext) => unknown>;

/**
 * 插件定义 —— 统一入口（每个 mod 的 index.ts default 导出）。
 * 四要素：meta + tools + hooks + services。
 * 服务（timer/sub-agent 等）经 plugin.services 声明，L5 useService 装载。
 */
export interface PluginDefinition {
  /** 插件元数据 */
  meta: PluginMeta;
  /** 工具（数组=共享 / 工厂=按 Agent 烘焙） */
  tools?: PluginTools;
  /** 钩子（静态映射 / 工厂=按 Agent 烘焙 config+services） */
  hooks?: PluginHookDef;
  /** 对外暴露的服务（服务名 → 工厂；L5 useService 惰性装载） */
  services?: PluginServicesDef;
}
