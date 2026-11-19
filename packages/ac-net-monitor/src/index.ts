// ============================================================
// ac-net-monitor —— 网络状态监控行（cr-1158）
//
// 依赖形态（插槽-插头）：
//   ac-net-monitor（本行，服务行）
//     ← ac-net-core（判定纯库：网卡分析 / DNS 探测 / 翻转状态机）
//   llm 服务的存在是本行意义前提（闸门拦截它的调用）——inject 声明。
//
// 用户需求（2026-11-19）：无网络（网线/WiFi 均断）时禁止调用网络
// 模型 API——定时唤醒触发的 run 不再挂协议超时 + 空转重试烧预算。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { NetMonitorService } from './service.ts';

export const name = 'ac-net-monitor';

export const inject = ['llm'];

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'netMonitor',
  label: '网络监控',
  description: '网络状态监控（ctx.netMonitor）：网卡轮询 + 断网时 DNS 兜底（在线期零探测流量）+ net/* 事件 + 离线时 llm/before-chat 闸门（远程端点禁止发起网络模型调用；本地/私网端点豁免）',
  listeners: [
    { event: 'llm/before-chat', role: '离线闸', description: '无网络时拒绝远程模型调用（本地/私网端点豁免）' },
  ],
};

export function apply(ctx: Context) {
  ctx.plugin(NetMonitorService);
}

// 契约出口：快照类型 + net/* 事件目录类型增强
export type { NetMonitorOptions, NetMonitorSnapshot } from './service.ts';
export { NetMonitorService } from './service.ts';
export type {} from './events.ts';