// ============================================================
// ac-web-server —— Web 传输服务行（ctx.webServer）
//
// 无 inject（零业务依赖的传输基座）。config（WebServerRowOptions）
// 经 loader/bootTree 传入 → 类插件以 (ctx, config) 构造。
// 契约出口固定形态：消费方 `import type {} from 'ac-web-server'`
// 即获得服务类型 + 域类型 + ws/* 事件目录的类型增强（type-only）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import z from '@agentchat/schemastery';
import { WebServerService, type WebServerRowOptions } from './service.ts';

export const name = 'ac-web-server';

/** 行配置（= WebServerRowOptions；本行是 cordis.yml 唯一接 config 的行包，导出 schema 供 loader 校验） */
export type Config = WebServerRowOptions;

export const Config: z<Config> = z.object({
  port: z.number(),
  host: z.string(),
  allowedOrigins: z.array(z.string()),
  allowedHosts: z.array(z.string()),
  staticDir: z.string(),
  dedupMs: z.number(),
  heartbeatMs: z.number(),
  maxBodyBytes: z.number(),
}) as z<Config>;

export function apply(ctx: Context, options: WebServerRowOptions = {}) {
  ctx.plugin(WebServerService, options);
}

export { WebServerService } from './service.ts';
export type { WebServerRowOptions } from './service.ts';

export type * from './contract.ts';
export type {} from './events.ts';
