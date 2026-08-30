// ============================================================
// ac-timer —— 定时任务插件行
//
// inject ['agents', 'agentStore', 'conversation', 'config']：
//   · agents      —— chime target '*' 解析（非 virtual 清单）
//   · agentStore  —— per-Agent 条目持久化唯一合法通道（entry 'timer'/'timer-archive'）
//   · conversation—— 触发投递（sender:'event'：串行化门 + MAX_AUTO_WAKES）
//   · config      —— 全局条目（sys.timer）持久化（key 'timer.tasks'）
// 机制任务目标（archive-all/backup-all）与历史种子（session）经
// ctx.get 运行时可选探测（不进 inject——软依赖）。
// 算法住 ac-timer-core 纯库；排程叠官方 cordis-timer。
// ============================================================
import type { Context } from '@agentchat/cordis';
import { TimersService, type TimerRowOptions } from './service.ts';

export const name = 'ac-timer';
export const inject = ['agents', 'agentStore', 'conversation', 'config'];

export function apply(ctx: Context, options: TimerRowOptions = {}) {
  ctx.plugin(TimersService, options);
}

export { GLOBAL_TIMER_OWNER, TimersService } from './service.ts';
export type { TimerRowOptions } from './service.ts';
export type { TimerEntry, GlobalScheduleEntry } from 'ac-timer-core';
