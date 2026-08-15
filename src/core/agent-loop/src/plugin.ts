// ============================================================
// @agentchat/agent-loop/src/plugin.ts —— ReAct 引擎插件行
//
// 提供 ctx.agentLoop（AgentLoopService：run/createContext/pushSteer）。
// 由 cordis.yml 挂载（无 inject 依赖）；registerCoreServices 兜底同构挂载。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { AgentLoopService } from './service';

export const name = 'agentchat-agent-loop';

export function apply(ctx: Context) {
  new AgentLoopService(ctx);
}
