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
// ── 扩展自述（A1 注册制目录）：ac-web-api 扫 cordis registry 读取本声明——
//    行卸载 = 条目自动消失；运行时零依赖（type-only import）。契约：ac-extension-core。
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'timers',
  label: '定时任务服务',
  description: '时间表驱动触发（config timer.tasks → sender:event 信封投递，机制任务不过 LLM）；时区/节假日 = settings.timers 分层（行 config 基线 → 全局默认层 → Agent 差异层覆盖，per-owner 生效）',
  automatic: true,
  fields: [
    { name: 'timezone', type: 'string', default: 'Asia/Shanghai', description: 'IANA 时区（如 Asia/Shanghai / UTC / America/New_York）——本 owner 日历条目（每天 HH:mm/周几/指定日）的目标时刻与记账时间戳都按它解释；差异层覆盖全局默认' },
    { name: 'holidays', type: 'list', description: '额外法定节假日（YYYY-MM-DD，每行一个；workday/holiday 模式门控）——配置即整体替换下层清单' },
    { name: 'makeupWorkdays', type: 'list', description: '调休工作日（YYYY-MM-DD；优先于节假日判定，周末调班为工作日）——配置即整体替换下层清单' },
  ],
};

export const inject = ['agents', 'agentStore', 'conversation', 'config'];

export function apply(ctx: Context, options: TimerRowOptions = {}) {
  ctx.plugin(TimersService, options);
}

export { GLOBAL_TIMER_OWNER, TimersService } from './service.ts';
export type { TimerRowOptions } from './service.ts';
export type { TimerEntry, GlobalScheduleEntry } from 'ac-timer-core';
