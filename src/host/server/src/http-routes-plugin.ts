// ============================================================
// @agentchat/server/src/http-routes-plugin.ts —— 传输层通用路由插件行（L3）
//
// 无独立业务域的路由（上传/配置/浏览/工作区/备份/版本/用量/会话）
// 由本行注册到 ctx.http。业务域路由由各自服务插件注册：
//   agents/history/groups  → server/src/service-plugin
//   plugins                 → plugins/src/http-plugin
//   ui + ui-plugin          → webui/src/plugin
// ============================================================
import * as path from 'path';
import type { Context } from '@agentchat/cordis';
import { createUploadRouter } from './api/upload';
import { createConfigRouter } from './api/config';
import { createBrowseRouter } from './api/browse';
import { createWorkspaceRouter } from './api/workspace';
import { createBackupRouter } from './api/backup';
import { createVersionRouter } from './api/version';
import { createUsageRouter } from './api/usage';
import { createSessionRouter } from './api/sessions';
import { configService } from './config-service';

export const name = 'agentchat-server-http-routes';
export const inject = ['http', 'l4'];

export function apply(ctx: Context) {
  const uploadDir = path.join(configService.getGlobalConfig().workspaceDir, 'files');
  const disposers = [
    ctx.http.register('/api/upload', createUploadRouter(uploadDir)),
    ctx.http.register('/api/config', createConfigRouter({ agentService: ctx.l4.agentService })),
    ctx.http.register('/api/browse', createBrowseRouter()),
    ctx.http.register('/api/workspace', createWorkspaceRouter()),
    ctx.http.register('/api/backup', createBackupRouter()),
    ctx.http.register('/api/version', createVersionRouter()),
    ctx.http.register('/api/usage', createUsageRouter()),
    ctx.http.register('/api/sessions', createSessionRouter()),
  ];
  ctx.logger('http').info('传输层通用路由已注册（upload/config/browse/workspace/backup/version/usage/sessions）');
  return () => disposers.forEach((dispose) => dispose());
}
