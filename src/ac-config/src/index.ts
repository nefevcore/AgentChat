// ============================================================
// ac-config —— 全局配置插件行
//
// 无 inject（零依赖基础服务）。config（{ root? }）经 loader/bootTree
// 传入 → 转构造参数（类插件以 (ctx, config) 构造）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ConfigService, type ConfigRowOptions } from './service.ts';

export const name = 'ac-config';

export function apply(ctx: Context, options: ConfigRowOptions = {}) {
  ctx.plugin(ConfigService, options);
}

export { ConfigService, readJson, writeJsonAtomic } from './service.ts';
export type { ConfigRowOptions } from './service.ts';

// 契约出口：事件目录类型增强（events.ts）
export type {} from './events.ts';
