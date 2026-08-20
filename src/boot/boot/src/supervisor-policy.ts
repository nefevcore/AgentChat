// ============================================================
// @agentchat/boot/src/supervisor-policy.ts —— L3 supervisor 监护策略（纯函数）
//
// 退出码协议（docs/restart-design.md §5.2）：
//   0   = 正常退出          → supervisor 一并退出
//   42  = 主动请求重拉      → 固定小延迟重拉，不计退避
//   78  = 启动期配置/组合失败（不会自愈）→ 不重拉，非 0 退出
//   其他 = 运行期崩溃       → 指数退避重拉，超限熔断
//
// 退避与熔断（§5.3）：
//   base=1.5s factor=2 cap=60s jitter=±20%
//   bootOk=30s（存活超此值退避归零）
//   crashWindow=10min 内 crashLimit=5 → 熔断退出
//
// 本模块只做决策（纯数据/逻辑，无 spawn/无 IO），supervisor.ts 持状态执行；
// 策略状态机可单测（fake child 协议矩阵，Phase 4 类化前的最小抽取）。
// ============================================================

/** 主动重启的约定退出码（worker → supervisor：重新拉起） */
export const EXIT_RESTART = 42;
/** 启动期配置/组合失败的约定退出码（worker → supervisor：不重拉） */
export const EXIT_CONFIG = 78;

/** 监护策略参数（§5.3；默认值即协议常量，可注入覆盖供测试） */
export interface SupervisionPolicy {
  /** 42 路径的固定重拉延迟（端口释放等待） */
  restartDelayMs: number;
  /** 崩溃退避基数 */
  backoffBaseMs: number;
  /** 崩溃退避倍率（delay = base × factor^streak） */
  backoffFactor: number;
  /** 崩溃退避上限 */
  backoffCapMs: number;
  /** 退避抖动比例（±；0 = 关闭） */
  backoffJitter: number;
  /** 存活超过该时长的崩溃把退避归零（运行了一阵 = 非启动循环） */
  bootOkMs: number;
  /** 熔断统计窗口 */
  crashWindowMs: number;
  /** 窗口内崩溃次数上限 → 熔断退出 */
  crashLimit: number;
}

export const DEFAULT_SUPERVISION_POLICY: SupervisionPolicy = {
  restartDelayMs: 1500,
  backoffBaseMs: 1500,
  backoffFactor: 2,
  backoffCapMs: 60_000,
  backoffJitter: 0.2,
  bootOkMs: 30_000,
  crashWindowMs: 10 * 60_000,
  crashLimit: 5,
};

/** 监护状态（supervisor 持有；decideOnExit 返回新副本） */
export interface SupervisionState {
  /** 连续崩溃计数（退避指数；bootOk 存活归零） */
  crashStreak: number;
  /** 窗口内崩溃时刻（epoch ms；仅 crashWindowMs 内的保留） */
  crashes: number[];
  /** 当前 worker 的 spawn 时刻（bootOk 判定用） */
  childStartedAt: number;
}

export function initialSupervisionState(childStartedAt: number): SupervisionState {
  return { crashStreak: 0, crashes: [], childStartedAt };
}

/** 退出处置决策 */
export type ExitDecision =
  | { action: 'restart'; delayMs: number; reason: string }
  | { action: 'exit'; exitCode: number; reason: string };

export interface ExitRuling {
  decision: ExitDecision;
  state: SupervisionState;
}

/** 对 jitter 延迟乘 ±ratio 的随机扰动（rng 可注入供测试） */
export function applyJitter(delayMs: number, ratio: number, rng: () => number = Math.random): number {
  if (ratio <= 0) return delayMs;
  const factor = 1 + (rng() * 2 - 1) * ratio;
  return Math.max(0, Math.round(delayMs * factor));
}

/**
 * 依据退出码/信号处置 worker 退出（纯函数：不改入参，返回新状态）。
 *
 * @param policy 策略参数
 * @param state 退出前的监护状态（childStartedAt = 该 worker 的 spawn 时刻）
 * @param code  worker 退出码（signal 终止时可能为 null）
 * @param signal 终止信号（SIGKILL/SIGTERM…；正常退出为 null）
 * @param now 当前时刻（可注入）
 * @param rng 随机源（jitter；可注入）
 */
export function decideOnExit(
  policy: SupervisionPolicy,
  state: SupervisionState,
  code: number | null,
  signal: NodeJS.Signals | null,
  now: number,
  rng: () => number = Math.random,
): ExitRuling {
  const livedMs = now - state.childStartedAt;

  if (code === 0) {
    return {
      decision: { action: 'exit', exitCode: 0, reason: '正常退出' },
      state,
    };
  }

  if (code === EXIT_RESTART) {
    // 主动重启：固定小延迟，不计退避、不进熔断窗口
    return {
      decision: {
        action: 'restart',
        delayMs: policy.restartDelayMs,
        reason: '主动重启请求（42）',
      },
      state,
    };
  }

  if (code === EXIT_CONFIG) {
    // 启动期配置失败：不会自愈，重拉只会死循环 → 不重拉
    return {
      decision: {
        action: 'exit',
        exitCode: EXIT_CONFIG,
        reason: '启动期配置/组合失败（78，不重拉）',
      },
      state,
    };
  }

  // 崩溃类（非 0/42/78，含 signal 强杀）：窗口计数 + 退避 + 熔断
  const crashes = [...state.crashes, now].filter((at) => now - at < policy.crashWindowMs);
  if (crashes.length >= policy.crashLimit) {
    return {
      decision: {
        action: 'exit',
        exitCode: 1,
        reason: `熔断：${policy.crashWindowMs / 1000}s 内第 ${crashes.length} 次崩溃（上限 ${policy.crashLimit}）`,
      },
      state: { ...state, crashes },
    };
  }

  const streak = livedMs >= policy.bootOkMs ? 0 : state.crashStreak;
  const rawDelay = Math.min(
    policy.backoffCapMs,
    policy.backoffBaseMs * Math.pow(policy.backoffFactor, streak),
  );
  return {
    decision: {
      action: 'restart',
      delayMs: applyJitter(rawDelay, policy.backoffJitter, rng),
      reason: `崩溃退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}，存活 ${Math.round(livedMs / 100) / 10}s，第 ${crashes.length}/${policy.crashLimit} 次）`,
    },
    state: { crashStreak: streak + 1, crashes, childStartedAt: state.childStartedAt },
  };
}
