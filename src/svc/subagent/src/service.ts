// ============================================================
// @agentchat/subagent/src/service.ts —— 子 Agent 服务（cordis Service）
//
// 第二阶段 cordis 化：ctx.subagent 暴露 SubAgentManager。
// 包装 bootstrap 已创建的 SubAgentManager 实例。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { SubAgentManager } from './subagent';

export class SubAgentService extends Service {
  /** SubAgentManager 实例 */
  readonly manager: SubAgentManager;

  constructor(ctx: Context, manager: SubAgentManager) {
    super(ctx, 'subagent');
    this.manager = manager;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 子 Agent 管理器（由 @agentchat/subagent 提供） */
    subagent: SubAgentService;
  }
}
