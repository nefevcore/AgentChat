// ============================================================
// ac-agents —— Agent 注册中心插件行
//
// 无 inject（不依赖其他服务）；Agent 数据由插件行（预设）或运行期
// API（ctx.agents.register）注入。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { AgentsService } from './service.ts';

export const name = 'ac-agents';

export function apply(ctx: Context) {
  ctx.plugin(AgentsService);
}

export { AgentsService, resolveToolNames, filterLlmParams, assertAgentId, capabilitySetOf, toolAllowedFor, LLM_SAMPLING_KEYS } from './service.ts';
export type { AgentConfig } from './service.ts';
export type {} from './events.ts';
