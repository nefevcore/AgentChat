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

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'agent-store',
  label: 'Agent 数据档案',
  description: 'Agent 数据目录 owning（ctx.agentStore）：config.json + 机制 entries + 文档实体（AGENT.md 等）',
  automatic: true,
};

export function apply(ctx: Context, options: AgentStoreRowOptions = {}) {
  ctx.plugin(AgentStoreService, options);
}

export { AgentStoreService } from './service.ts';
export type { AgentStoreRowOptions } from './service.ts';
