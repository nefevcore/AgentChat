// ============================================================
// @agentchat/timer/src/service.ts —— 定时任务服务（cordis Service）
//
// 第二阶段 cordis 化：ctx.timerManager 暴露 TimerManager。
// 服务名使用 timerManager：'timer' 保留给 @agentchat/cordis-timer
//（HMR 的低层 disposable timer 服务），避免两个 TimerService 冲突。
// ============================================================
import { Service, type Context } from '@agentchat/cordis';
import { TimerManager } from './timer';

export class TimerService extends Service {
  /** TimerManager 实例 */
  readonly manager: TimerManager;

  constructor(ctx: Context, manager: TimerManager) {
    super(ctx, 'timerManager');
    this.manager = manager;
  }
}

declare module '@agentchat/cordis' {
  interface Context {
    /** 定时任务管理器（由 @agentchat/timer 提供） */
    timerManager: TimerService;
  }
}
