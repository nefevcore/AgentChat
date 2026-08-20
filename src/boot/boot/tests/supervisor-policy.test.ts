// ============================================================
// @agentchat/boot 测试：supervisor-policy —— L3 监护决策状态机
// 协议矩阵（docs/restart-design.md §5.2/§5.3）：
//   0 退出 · 42 固定延迟重拉（不计退避）· 78 不重拉 · 崩溃退避重拉 ·
//   bootOk 归零 · 窗口熔断
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPERVISION_POLICY,
  EXIT_CONFIG,
  EXIT_RESTART,
  applyJitter,
  decideOnExit,
  initialSupervisionState,
  type SupervisionPolicy,
} from '../src/supervisor-policy';

const T0 = 1_700_000_000_000; // 固定时基

/** 小策略：时基压缩（base 1s ×2 cap 60s bootOk 10s 窗口 100s 上限 5——
 *  退避序列测试不触发熔断） */
const policy: SupervisionPolicy = {
  ...DEFAULT_SUPERVISION_POLICY,
  restartDelayMs: 1000,
  backoffBaseMs: 1000,
  backoffFactor: 2,
  backoffCapMs: 60_000,
  backoffJitter: 0,
  bootOkMs: 10_000,
  crashWindowMs: 100_000,
  crashLimit: 5,
};

describe('退出码协议', () => {
  it('0 → supervisor 一并退出', () => {
    const ruling = decideOnExit(policy, initialSupervisionState(T0), 0, null, T0 + 5000);
    expect(ruling.decision).toEqual({ action: 'exit', exitCode: 0, reason: '正常退出' });
  });

  it('42 → 固定延迟重拉，不计退避、不进熔断窗口', () => {
    const state = { ...initialSupervisionState(T0), crashStreak: 4, crashes: [T0, T0, T0] };
    const ruling = decideOnExit(policy, state, EXIT_RESTART, null, T0 + 5000);
    expect(ruling.decision.action).toBe('restart');
    expect((ruling.decision as { delayMs: number }).delayMs).toBe(1000);
    // 状态原样返回（退避与窗口不受 42 影响）
    expect(ruling.state.crashStreak).toBe(4);
    expect(ruling.state.crashes).toHaveLength(3);
  });

  it('78 → 不重拉，supervisor 以 78 退出', () => {
    const ruling = decideOnExit(policy, initialSupervisionState(T0), EXIT_CONFIG, null, T0 + 5000);
    expect(ruling.decision).toEqual({
      action: 'exit', exitCode: 78, reason: expect.stringContaining('78'),
    });
  });
});

describe('崩溃退避', () => {
  it('指数退避：1s → 2s → 4s（cap 60s），rng 可注入', () => {
    let state = initialSupervisionState(T0);
    // 三连崩溃：启动后 1s 死（< bootOk 10s）
    const d1 = decideOnExit(policy, state, 1, null, T0 + 1000);
    expect((d1.decision as { delayMs: number }).delayMs).toBe(1000);
    state = { ...d1.state, childStartedAt: T0 + 2000 };
    const d2 = decideOnExit(policy, state, 1, null, T0 + 3000);
    expect((d2.decision as { delayMs: number }).delayMs).toBe(2000);
    state = { ...d2.state, childStartedAt: T0 + 5000 };
    const d3 = decideOnExit(policy, state, 1, null, T0 + 6000);
    expect((d3.decision as { delayMs: number }).delayMs).toBe(4000);
    expect(d3.state.crashStreak).toBe(3);
  });

  it('退避封顶 backoffCapMs', () => {
    const state = { ...initialSupervisionState(T0), crashStreak: 20 };
    const ruling = decideOnExit(policy, state, 1, null, T0 + 1000);
    expect((ruling.decision as { delayMs: number }).delayMs).toBe(60_000);
  });

  it('bootOk：存活 ≥ bootOkMs 的崩溃把退避归零（非启动循环）', () => {
    const state = { ...initialSupervisionState(T0), crashStreak: 5 };
    const ruling = decideOnExit(policy, state, 1, null, T0 + 11_000);
    expect((ruling.decision as { delayMs: number }).delayMs).toBe(1000);
    expect(ruling.state.crashStreak).toBe(1);
  });

  it('signal 强杀（code=null）按崩溃处置', () => {
    const ruling = decideOnExit(policy, initialSupervisionState(T0), null, 'SIGKILL', T0 + 1000);
    expect(ruling.decision.action).toBe('restart');
    expect((ruling.decision as { reason: string }).reason).toContain('SIGKILL');
  });

  it('窗口外旧崩溃被剪除（不再计入熔断）', () => {
    const state = {
      ...initialSupervisionState(T0),
      crashes: [T0 - 500_000], // 窗口（100s）之外
      crashStreak: 0,
    };
    const ruling = decideOnExit(policy, state, 1, null, T0 + 1000);
    expect(ruling.decision.action).toBe('restart');
    expect(ruling.state.crashes).toHaveLength(1); // 只剩本次
  });
});

describe('熔断', () => {
  it('窗口内达到 crashLimit → 熔断退出（非 0）', () => {
    const state = {
      ...initialSupervisionState(T0),
      crashes: [T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000], // 已有 4 次（limit=5）
      crashStreak: 4,
    };
    const ruling = decideOnExit(policy, state, 1, null, T0 + 5000);
    expect(ruling.decision.action).toBe('exit');
    expect((ruling.decision as { exitCode: number }).exitCode).toBe(1);
    expect((ruling.decision as { reason: string }).reason).toContain('熔断');
  });
});

describe('applyJitter', () => {
  it('±ratio 比例扰动；rng=中值时不变；ratio=0 关闭', () => {
    expect(applyJitter(1000, 0.2, () => 0.5)).toBe(1000);
    expect(applyJitter(1000, 0.2, () => 0)).toBe(800);
    expect(applyJitter(1000, 0.2, () => 1)).toBe(1200);
    expect(applyJitter(1000, 0, () => 0)).toBe(1000);
  });
});

describe('协议常量', () => {
  it('默认策略 = §5.3 协议常量', () => {
    expect(DEFAULT_SUPERVISION_POLICY).toEqual({
      restartDelayMs: 1500,
      backoffBaseMs: 1500,
      backoffFactor: 2,
      backoffCapMs: 60_000,
      backoffJitter: 0.2,
      bootOkMs: 30_000,
      crashWindowMs: 600_000,
      crashLimit: 5,
    });
    expect(EXIT_RESTART).toBe(42);
    expect(EXIT_CONFIG).toBe(78);
  });
});
