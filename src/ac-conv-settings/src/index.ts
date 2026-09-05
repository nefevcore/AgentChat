// ============================================================
// ac-conv-settings —— 会话设置插件行
//
// inject 无（零依赖基础服务，数据自持）。config（{ root? }）经
// loader/bootTree 传入 → 转构造参数。
// 生效合并点在 ac-web-api 的 conversation/deliver（薄编排行）：
// 入参 model 缺省时查 ctx.convSettings.get(conversationId) 补投——
// 会话级模型覆盖在会话边界单点生效，任何客户端零改动获得同一语义。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { ConvSettingsService, type ConvSettingsRowOptions } from './service.ts';

export const name = 'ac-conv-settings';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'conv-settings',
  label: '会话级设置',
  description: '按 conversationId 的会话级模型覆盖（name@model 引用；deliver 边界单点生效）',
  automatic: true,
};

export function apply(ctx: Context, options: ConvSettingsRowOptions = {}) {
  ctx.plugin(ConvSettingsService, options);
}

// 契约出口：域类型（contract.ts）+ 事件目录类型增强（events.ts）
export type * from './contract.ts';
export type {} from './events.ts';

export { ConvSettingsService } from './service.ts';
export type { ConvSettingsRowOptions } from './service.ts';
