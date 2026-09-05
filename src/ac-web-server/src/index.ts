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

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'web-server',
  label: 'Web 传输基座',
  description: 'Web 传输基座（ctx.webServer）：HTTP 路由 + WS 广播 + RPC 显式注册 + 静态托管',
  automatic: true,
};

/** 行配置（= WebServerRowOptions；yml 接 config 的行包[另见 ac-mcp]，导出 schema 供 loader 校验） */
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
