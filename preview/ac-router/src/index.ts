// ============================================================
// ac-router —— 消息路由插件行（纯转发，零会话状态）
//
// inject ['agents', 'agentLoop']：能力依赖（Agent 数据源 + 执行引擎）。
// send = agents 解析 AgentConfig → 构建信封投递 agentLoop；
// 此前会话由调用方经 options.history 提供（将来的 ac-session 走事件）。
// 通知订阅方（历史/WS/审计）不需要 inject 本服务 —— 走事件。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { RouterService } from './service.ts';

export const name = 'ac-router';
export const inject = ['agents', 'agentLoop'];

export function apply(ctx: Context) {
  ctx.plugin(RouterService);
}

export { RouterService } from './service.ts';
export type { RouterInbound, RouterSendOptions } from './service.ts';

// agentOf 命名读取器（M25 §3.2：owning 包导出，类型锚定自家事件签名）
export { agentOfMessage } from './readers.ts';

// 契约出口：router/* 事件目录类型增强（谁 emit 谁声明）
export type {} from './events.ts';
