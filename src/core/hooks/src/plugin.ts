// ============================================================
// @agentchat/hooks/src/plugin.ts —— 钩子注册中心插件（cordis 服务行）
//
// 提供 ctx.hooks（HooksService）。builtin 钩子已拆到扩展域独立行注册
// （agent-prompt/agent-skill/agent-session/agent-memory/agent-mcp/
// security，每域一行，可插拔）；本行仅保留内联的 toolExecutionEnd
// 轻量日志钩子。
// 由 cordis.yml 挂载；registerCoreServices 的无 Loader 兜底同样经本行。
// ============================================================
import type { Context } from '@agentchat/cordis';
import type { ToolExecutionOutcome } from '@agentchat/agent-loop';
import { HooksService } from './service';

export const name = 'agentchat-hooks';

export function apply(ctx: Context) {
  const hooks = new HooksService(ctx);
  // toolExecutionEnd：轻量日志（hooks 内联）
  hooks.register('toolExecutionEnd', 'hooks.log-tool', () => async (outcome: ToolExecutionOutcome) => {
    ctx.logger('hooks').info(`工具 ${outcome.toolName} 完成，耗时 ${outcome.durationMs ?? '?'}ms${outcome.error ? '（异常）' : ''}`);
  }, name);
  ctx.logger('hooks').info('ctx.hooks 就绪（钩子域各自成行注册）');
}
