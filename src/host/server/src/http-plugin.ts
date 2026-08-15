// ============================================================
// @agentchat/server/src/http-plugin.ts —— HTTP 路由注册表插件行（L3）
//
// 宿主只提供注册口（ctx.http），不拥有任何业务路由。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { HttpRouteRegistry } from './http-routes';

export const name = 'agentchat-http';
export const inject: string[] = [];

export function apply(ctx: Context) {
  new HttpRouteRegistry(ctx);
  ctx.logger('http').info('HTTP 路由注册表就绪（ctx.http）');
}
