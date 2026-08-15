// ============================================================
// Runtime —— 运行时对象门面（L4，server/ws 唯一入口）
//
// 设计文档 7.1："webui/server 只 import services/（不直接 import core/agents 内部）"。
// WebSocket 传输层需要 L2 运行时对象（Router / Registry / GroupManager）与
// L5 重启函数、全局配置 —— 经本门面由 app 装配注入，server 不再直接 import @agents/@app。
//
// 依赖方向：
//   · services → agents/core（类型引用，services 聚合 core/agents/plugins，允许）
//   · services → app ✗（重启函数经 initRuntime 依赖注入，避免 services→app）
//
// 说明：新架构 AgentRouter 内置 Registry + GroupManager（1:1 生命周期），
//   getRegistry()/getGroupManager() 从 router 派生，无需分别注入。
// ============================================================

import type { AgentRouter } from '@agentchat/router';
import type { AgentRegistry } from '@agentchat/agents';
import type { GroupManager } from '@agentchat/router';
import type { RouterMessage } from '@agentchat/router';
import { createLogger } from '@agentchat/util';

const log = createLogger('[services:runtime]');

// ---- 类型再导出（server 只 import services，类型也经此传递）----
export type { AgentRouter } from '@agentchat/router';
export type { AgentRegistry } from '@agentchat/agents';
export type { GroupManager } from '@agentchat/router';
export type { RouterMessage } from '@agentchat/router';

// ---- 运行时对象（app 装配注入，一次设置）----
let router: AgentRouter | null = null;
/** 系统重启函数（L5 app/shutdown 注入，DI 避免 services→app 依赖） */
let restartFn: ((reason?: string) => void) | null = null;
/** 全局配置（L5 bootstrap 注入：workspace/config.json 等；services 聚合读） */
let globalConfig: Record<string, any> = {};

export interface RuntimeDeps {
  router: AgentRouter;
  /** 系统重启（Supervisor 拉起 / 非托管退化为退出），由 app 装配注入 */
  requestRestart?: (reason?: string) => void;
  /** 全局配置对象（llmProviders/searchProviders/workspaceDir 等；缺省空对象） */
  globalConfig?: Record<string, any>;
}

/**
 * app 装配时调用一次，注入 L2/L5 运行时对象与全局配置。
 * 必须在创建 WebUIServer / WSHandler 之前调用。
 */
export function initRuntime(deps: RuntimeDeps): void {
  router = deps.router;
  restartFn = deps.requestRestart ?? null;
  globalConfig = deps.globalConfig ?? {};
  log.info('运行时门面已初始化（Router 注入 + 全局配置）');
}

/** 获取消息路由（未注入时抛错，标识装配顺序问题） */
export function getRouter(): AgentRouter {
  if (!router) throw new Error('[Runtime] Router 未注入（initRuntime 未调用）');
  return router;
}

/** 获取 Agent 注册表（Router 内置；未注入时抛错） */
export function getRegistry(): AgentRegistry {
  return getRouter().getRegistry();
}

/** 获取群组管理器（Router 内置） */
export function getGroupManager(): GroupManager {
  return getRouter().getGroupManager();
}

/** 请求系统重启（Supervisor 模式下以退出码 42 由父进程拉起） */
export function requestRestart(reason?: string): void {
  if (restartFn) restartFn(reason);
  else log.warn('requestRestart 未注入（非 Supervisor 或 initRuntime 未调用）');
}

/** 获取全局配置（L5 bootstrap 注入；未注入时为空对象） */
export function getGlobalConfig(): Record<string, any> {
  return globalConfig;
}

/** 更新全局配置（L5 bootstrap / ConfigService.reloadGlobalConfig 调用） */
export function setGlobalConfig(cfg: Record<string, any>): void {
  globalConfig = cfg ?? {};
}

/** 更新重启函数（boot-finalize 在 shutdown 域就绪后注入实际 requestRestart） */
export function setRequestRestart(fn: ((reason?: string) => void) | null): void {
  restartFn = fn;
}
