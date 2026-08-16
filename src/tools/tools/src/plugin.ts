// ============================================================
// @agentchat/tools/src/plugin.ts —— 工具注册中心插件（cordis 服务行）
//
// 提供 ctx.tools（ToolsService）。工具领域包（fs/shell/web/dev/
// session-tools/restart/interaction）各自独立成行注册（每域一行，可插拔）；
// 本行不再聚合（契约化阶段⑤，2026-08-14）。
// 由 cordis.yml 挂载；registerCoreServices 的无 Loader 兜底同样经本行。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ToolsService } from './service';

export const name = 'agentchat-tools';

export function apply(ctx: Context) {
  new ToolsService(ctx);
  ctx.logger('tools').info('工具注册中心就绪（ctx.tools）');
}
