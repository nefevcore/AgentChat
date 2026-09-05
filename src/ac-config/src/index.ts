// ============================================================
// ac-config —— 全局配置插件行
//
// 无 inject（零依赖基础服务）。config（{ root? }）经 loader/bootTree
// 传入 → 转构造参数（类插件以 (ctx, config) 构造）。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ConfigService, type ConfigRowOptions } from './service.ts';

export const name = 'ac-config';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'config',
  label: '全局配置',
  description: '全局配置（ctx.config）：数据根 config.json 原子读写 + config/changed 热重载',
  automatic: true,
};

export function apply(ctx: Context, options: ConfigRowOptions = {}) {
  ctx.plugin(ConfigService, options);
}

export { ConfigService, readJson, writeJsonAtomic } from './service.ts';
export type { ConfigRowOptions } from './service.ts';

// 契约出口：事件目录类型增强（events.ts）
export type {} from './events.ts';
