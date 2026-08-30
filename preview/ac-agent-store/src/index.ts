// ============================================================
// ac-agent-store —— Agent 数据目录插件行
//
// 无 inject（零运行时依赖；AgentConfig 仅 type-import）。
// 目录扫描物化进 ctx.agents 的是姊妹行 ac-agents-dir（职责分离）。
// config（{ root? }）经 loader/bootTree 传入 → 转构造参数。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { AgentStoreService, type AgentStoreRowOptions } from './service.ts';

export const name = 'ac-agent-store';

export function apply(ctx: Context, options: AgentStoreRowOptions = {}) {
  ctx.plugin(AgentStoreService, options);
}

export { AgentStoreService } from './service.ts';
export type { AgentStoreRowOptions } from './service.ts';
