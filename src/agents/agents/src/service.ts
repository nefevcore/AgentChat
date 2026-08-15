// ============================================================
// @agentchat/agents/src/service.ts —— Agent 调度服务（cordis Service）
//
// 第二阶段 cordis 化：ctx.agents 聚合 Agent 注册表 + 消息路由。
//   · registry —— AgentRegistry（配置注册/查找）
//   · router   —— AgentRouter（消息分发 / steer / pending 落盘）
// 装配：包装 boot 层已创建的 router（避免重复装配 AgentAssembly）。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { AgentRegistry } from './registry';

/**
 * 消息路由最小契约（装配层传入真实 AgentRouter）。
 * 契约化⑤：agents 不再 import type @agentchat/router，
 * 以消除 agents↔router 类型级 package 环。
 */
export interface AgentRouterLike {
  getRegistry(): AgentRegistry;
}

export class AgentsService extends Service {
  /** Agent 注册表 */
  readonly registry: AgentRegistry;
  /** 消息路由（内置 Registry + GroupManager） */
  readonly router: AgentRouterLike;

  constructor(ctx: Context, router: AgentRouterLike, registry?: AgentRegistry) {
    super(ctx, 'agents');
    this.router = router;
    this.registry = registry ?? router.getRegistry();
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** Agent 注册表 + 消息路由（由 @agentchat/agents 提供） */
    agents: AgentsService;
  }
}
