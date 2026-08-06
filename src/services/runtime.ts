// ============================================================
// RuntimeService —— 运行时对象门面（v0.5.0 收敛）
//
// 设计文档 7.1："webui/server 只 import services/（不直接 import core 内部）"。
// WebSocket 传输层需要 L2 运行时对象（Router / Registry / GroupManager）与
// L5 重启函数 —— 经本门面由 app 装配注入，server 不再直接 import @agents/@app。
//
// 依赖方向：
//   · services → agents/core（类型引用，services 聚合 core/agents/plugins，允许）
//   · services → app ✗（重启函数经 initRuntime 依赖注入，避免 services→app）
// ============================================================

import type { AgentRouter } from '@agents/router';
import type { AgentRegistry } from '@agents/registry';
import type { GroupManager } from '@agents/group';
import type { AgentMessage } from '@core/types';
import { logger } from '@utils/logger';

// ---- 类型再导出（server 只 import services，类型也经此传递）----
export type { AgentRouter } from '@agents/router';
export type { AgentRegistry } from '@agents/registry';
export type { GroupManager } from '@agents/group';
export type { AgentMessage } from '@core/types';

// ---- 运行时对象（app 装配注入，一次设置）----
let router: AgentRouter | null = null;
let registry: AgentRegistry | null = null;
let groupManager: GroupManager | null = null;
/** 系统重启函数（L5 app/shutdown 注入，DI 避免 services→app 依赖） */
let restartFn: ((reason?: string) => void) | null = null;

export interface RuntimeDeps {
  router: AgentRouter;
  registry: AgentRegistry;
  groupManager?: GroupManager;
  /** 系统重启（Supervisor 拉起 / 非托管退化为退出），由 app 装配注入 */
  requestRestart?: (reason?: string) => void;
}

/**
 * app 装配时调用一次，注入 L2/L5 运行时对象。
 * 必须在创建 WebUIServer / WSHandler 之前调用。
 */
export function initRuntime(deps: RuntimeDeps): void {
  router = deps.router;
  registry = deps.registry;
  groupManager = deps.groupManager ?? null;
  restartFn = deps.requestRestart ?? null;
  logger.info('[Runtime] 运行时门面已初始化（Router/Registry/GroupManager 注入）');
}

/** 获取消息路由（未注入时抛错，标识装配顺序问题） */
export function getRouter(): AgentRouter {
  if (!router) throw new Error('[Runtime] Router 未注入（initRuntime 未调用）');
  return router;
}

/** 获取 Agent 注册表（未注入时抛错，标识装配顺序问题） */
export function getRegistry(): AgentRegistry {
  if (!registry) throw new Error('[Runtime] Registry 未注入（initRuntime 未调用）');
  return registry;
}

/** 获取群组管理器（未启用群组时为 null） */
export function getGroupManager(): GroupManager | null {
  return groupManager;
}

/** 请求系统重启（Supervisor 模式下以退出码 42 由父进程拉起） */
export function requestRestart(reason?: string): void {
  if (restartFn) restartFn(reason);
  else logger.warn('[Runtime] requestRestart 未注入（非 Supervisor 或 initRuntime 未调用）');
}
