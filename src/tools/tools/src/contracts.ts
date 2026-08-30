// ============================================================
// @agentchat/tools/src/contracts.ts —— 工具上下文契约（ToolContext）
//
// 迁移自 src/plugins/types.ts 的 PluginServices（本次工具族用到的注入面）。
// 工具工厂签名：(config: AgentConfig, services: ToolContext) => Tool[]。
// cordis 化后该注入面将由服务声明（inject）取代，此处保持结构契约。
//
// 铁律：仅类型引用，不产生运行时依赖。
// ============================================================

import type { AgentRouter } from '@agentchat/router';
import type { Tool } from '@agentchat/contracts';
import type { LLMRequestMessage } from '@agentchat/types';

/** 历史恢复调和（agent-session load-history 钩子调用；由宿主装配注入） */
export type HistoryRecovery = (
  history: LLMRequestMessage[],
  opts: { dialogId: string; agentId: string },
) => LLMRequestMessage[];

/** 用户交互桥（ask_questions 工具用；L4 services 提供） */
export interface ToolInteraction {
  askQuestions(opts: {
    agentId: string;
    convKey: string;
    questions: Array<{ question: string; options: string[] }>;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** 与执行点关联的稳定键（如 tool_call_id），恢复对账用 */
    correlationId?: string;
  }): Promise<string[]>;
}

/**
 * 工具运行时注入面（对应原 PluginServices）。
 * 本次（files/web/session/app 族）实际消费：router / searchProviders / interaction；
 * 其余字段为延迟占位（svc 域迁移后收紧类型）。
 */
export interface ToolContext {
  /** 消息路由（会话历史工具用） */
  router?: AgentRouter;
  /** 搜索 provider 池（web_search 用） */
  searchProviders?: Record<string, Record<string, unknown>>;
  /** 用户交互桥（ask_questions 用） */
  interaction?: ToolInteraction;
  /** 历史恢复调和（agent-session 加载历史后调用；由宿主注入） */
  recoverHistory?: HistoryRecovery;
  // ---- 延迟字段（svc 域迁移后收紧；当前占位保持结构兼容）----
  /** LLM 实例（subagent 工具用） */
  llm?: unknown;
  /** 当前 Agent 工具集（subagent 工具用） */
  tools?: Map<string, Tool>;
  /** 定时任务管理器（timer 工具用；svc 域迁移后收紧） */
  timer?: unknown;
  /** 子 Agent 管理器（subagent 工具用；svc 域迁移后收紧） */
  subAgent?: unknown;
  /** Agent 配置目录 */
  agentsDir?: string;
  /** 工作区根（插件开发/发布工具用；<ws>/plugins 插件库所在） */
  workspaceDir?: string;
  /** 归档编排（runEnd archive-session 钩子用） */
  archiveSession?: unknown;
  /** 空闲归档计时器重置 */
  idleReset?: unknown;
  /** 输出脱敏 secrets（security.redact-output 钩子工厂使用；L5 装配注入） */
  redactSecrets?: string[];
}

// ============================================================
// PluginServices —— 插件运行时服务注入面（迁自 @agentchat/plugins/types.ts）
// 工具/钩子工厂签名 (config, services) 的第二参数；装配层经 ctx 服务注入。
// ============================================================
import type { TimerManager } from '@agentchat/timer';
import type { SubAgentManager } from '@agentchat/subagent';
import type { LLMProvider } from '@agentchat/llm';
import type { CurrentContext } from '@agentchat/contracts';
import type { RunResult } from '@agentchat/contracts';

/** 插件运行时服务（L5 装配时注入；工具经工厂第二个参数访问） */
export interface PluginServices {
  /** 消息路由（send_agent / send_group / list_agents / list_groups 等用） */
  router?: AgentRouter;
  /** 当前 Agent 的 LLM 实例（subagent 子 Agent 共享） */
  llm?: LLMProvider;
  /** 当前 Agent 的工具集 */
  tools?: Map<string, Tool>;
  /** 定时任务管理器（timer 工具用） */
  timer?: TimerManager;
  /** 子 Agent 管理器（subagent 工具用） */
  subAgent?: SubAgentManager;
  /** 用户交互桥（ask_questions 用） */
  interaction?: {
    askQuestions(opts: {
      agentId: string;
      convKey: string;
      questions: Array<{ question: string; options: string[] }>;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** 与执行点关联的稳定键（如 tool_call_id），恢复对账用 */
      correlationId?: string;
    }): Promise<string[]>;
  };
  /** 历史恢复调和（agent-session 加载历史后调用；由宿主注入） */
  recoverHistory?: HistoryRecovery;
  /** 搜索 provider 池（web_search 用） */
  searchProviders?: Record<string, Record<string, unknown>>;
  /** Agent 配置目录 */
  agentsDir?: string;
  /** 工作区根（插件开发/发布工具用；<ws>/plugins 插件库所在） */
  workspaceDir?: string;
  /** 归档编排（runEnd archive-session 钩子用） */
  archiveSession?: (ctx: CurrentContext, result: RunResult) => Promise<void> | void;
  /** 空闲归档计时器重置 */
  idleReset?: (dialogId: string, selfId?: string) => void;
  /** 输出脱敏 secrets（security.redact-output 钩子工厂使用；L5 装配注入） */
  redactSecrets?: string[];
}
