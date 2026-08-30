// ============================================================
// ac-supervisor-core —— Supervisor 监护策略纯库（零 cordis 依赖）
//
// src boot/supervisor-policy.ts 原样搬运（资产 #6）+ .runtime 单写者
// 锁（资产 #7：wx 排他创建消灭双启 TOCTOU——M12 ac-timer 遗留项的
// M13 落点）。本模块只做决策（纯数据/逻辑，无 spawn/无事件循环状态），
// supervisor.mjs 进程层脚本持状态执行。
//
// 退出码协议（宿主 worker → supervisor）：
//   0   = 正常退出          → supervisor 一并退出
//   42  = 主动请求重拉      → 固定小延迟重拉，不计退避（端口释放等待）
//   78  = 启动期配置/组合失败（不会自愈）→ 不重拉，非 0 退出
//   其他 = 运行期崩溃       → 指数退避重拉，超限熔断
// ============================================================
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** 主动重启的约定退出码（worker → supervisor：重新拉起） */
export const EXIT_RESTART = 42;
/** 启动期配置/组合失败的约定退出码（worker → supervisor：不重拉） */
export const EXIT_CONFIG = 78;

/** 监护策略参数（默认值即协议常量，可注入覆盖供测试） */
export interface SupervisionPolicy {
  restartDelayMs: number;
  backoffBaseMs: number;
  backoffFactor: number;
  backoffCapMs: number;
  backoffJitter: number;
  bootOkMs: number;
  crashWindowMs: number;
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
  crashStreak: number;
  crashes: number[];
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
    return { decision: { action: 'exit', exitCode: 0, reason: '正常退出' }, state };
  }

  if (code === EXIT_RESTART) {
    // 主动重启：固定小延迟，不计退避、不进熔断窗口
    return {
      decision: { action: 'restart', delayMs: policy.restartDelayMs, reason: '主动重启请求（42）' },
      state,
    };
  }

  if (code === EXIT_CONFIG) {
    // 启动期配置失败：不会自愈，重拉只会死循环 → 不重拉
    return {
      decision: { action: 'exit', exitCode: EXIT_CONFIG, reason: '启动期配置/组合失败（78，不重拉）' },
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
  const rawDelay = Math.min(policy.backoffCapMs, policy.backoffBaseMs * Math.pow(policy.backoffFactor, streak));
  return {
    decision: {
      action: 'restart',
      delayMs: applyJitter(rawDelay, policy.backoffJitter, rng),
      reason: `崩溃退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}，存活 ${Math.round(livedMs / 100) / 10}s，第 ${crashes.length}/${policy.crashLimit} 次）`,
    },
    state: { crashStreak: streak + 1, crashes, childStartedAt: state.childStartedAt },
  };
}

// ============================================================
// .runtime 单写者锁（资产 #7：wx 排他创建消灭双启 TOCTOU）
// ============================================================

/**
 * 以 'wx' 排他模式创建单写者标识文件。
 * 已存在（双启）→ 陈旧锁回收后重试一次（M16：Windows 上持有进程
 * 崩溃/被强杀后锁文件残留——wx 打开恒 EEXIST，supervised 永久 78）；
 * 仍失败 → 抛 EEXIST 错误（真实双启）。成功 → 返回解锁函数。
 * 陈旧判定：文件内记录的 pid 在本机已不存在（ESRCH）——pid 被复用
 * （仍存活）时保守视为持有者仍活，不回收。
 */
export function acquireRuntimeLock(runtimeFile: string): () => void {
  try {
    return lockOnce(runtimeFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && isStaleLock(runtimeFile)) {
      try {
        rmSync(runtimeFile, { force: true });
      } catch { /* ignore */ }
      return lockOnce(runtimeFile); // 陈旧锁回收后重试一次
    }
    throw err;
  }
}

function lockOnce(runtimeFile: string): () => void {
  const fd = openSync(runtimeFile, 'wx');
  writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  return () => {
    try {
      closeSync(fd);
    } catch { /* ignore */ }
    try {
      rmSync(runtimeFile, { force: true });
    } catch { /* ignore */ }
  };
}

/** 锁文件是否陈旧（持有进程已不在本机存活） */
function isStaleLock(runtimeFile: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(runtimeFile, 'utf-8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return true;
    try {
      process.kill(parsed.pid, 0);
      return false; // pid 存活（含被复用）——保守视为持有者仍活
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    return true; // 读不了/坏文件 → 视为陈旧可回收
  }
}

/** runtime 锁文件路径（<root>/.runtime） */
export function runtimeLockPath(root: string): string {
  return join(root, '.runtime');
}
