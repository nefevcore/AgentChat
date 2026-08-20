// ============================================================
// @agentchat/agent-presets/src/plugin.ts —— 预设 Agent 插件行
//
// 提供 ctx.agentPresets 并登记内置预设（presets/ 数据文件）。
// 消费方：server service-plugin（物化进 AgentRegistry + /api/agent-presets）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { AgentPresetsService } from './service';
import { BUILTIN_PRESETS } from './register';

export const name = 'agentchat-agent-presets';

export function apply(ctx: Context) {
  const presets = new AgentPresetsService(ctx);
  for (const def of BUILTIN_PRESETS) {
    presets.register(def, name);
  }
  ctx.logger('agent-presets').info(`ctx.agentPresets 就绪（内置预设 ${BUILTIN_PRESETS.length} 个：${BUILTIN_PRESETS.map((d) => d.agent.agent_id).join(', ')}）`);
}
