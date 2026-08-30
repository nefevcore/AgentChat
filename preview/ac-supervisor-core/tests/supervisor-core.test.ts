// ============================================================
// ac-supervisor-core：42/78/0 协议 + 退避熔断纯函数 + .runtime 单写者
// ============================================================
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SUPERVISION_POLICY,
  EXIT_CONFIG,
  EXIT_RESTART,
  acquireRuntimeLock,
  applyJitter,
  decideOnExit,
  initialSupervisionState,
  runtimeLockPath,
} from '../src/index.ts';

const POLICY = { ...DEFAULT_SUPERVISION_POLICY, backoffJitter: 0 }; // 确定性
const T0 = 1_000_000;

describe('退出码协议', () => {
  it('0 = 正常退出：supervisor 一并退出', () => {
    const ruling = decideOnExit(POLICY, initialSupervisionState(T0), 0, null, T0 + 5000);
    expect(ruling.decision).toEqual({ action: 'exit', exitCode: 0, reason: '正常退出' });
  });

  it('42 = 主动重启：固定延迟重拉，不计退避不进熔断窗口', () => {
    const ruling = decideOnExit(POLICY, initialSupervisionState(T0), EXIT_RESTART, null, T0 + 5000);
    expect(ruling.decision.action).toBe('restart');
    if (ruling.decision.action === 'restart') {
      expect(ruling.decision.delayMs).toBe(POLICY.restartDelayMs);
      expect(ruling.decision.reason).toContain('42');
    }
    expect(ruling.state.crashes).toHaveLength(0);
  });

  it('78 = 启动期配置失败：不重拉，非 0 退出', () => {
    const ruling = decideOnExit(POLICY, initialSupervisionState(T0), EXIT_CONFIG, null, T0 + 100);
    expect(ruling.decision).toEqual({
      action: 'exit',
      exitCode: 78,
      reason: expect.stringContaining('78'),
    });
  });
});

describe('崩溃退避与熔断', () => {
  it('指数退避：base ×2 封顶 cap；存活 ≥ bootOk 归零', () => {
    // crashLimit 放宽（本测聚焦退避数列；熔断另测）
    const policy = { ...POLICY, crashLimit: 20 };
    // 启动即崩（存活 1s < 30s）：streak 递增
    let state = initialSupervisionState(T0);
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ruling = decideOnExit(policy, state, 1, null, T0 + i * 10_000 + 1000);
      if (ruling.decision.action === 'restart') delays.push(ruling.decision.delayMs);
      state = { ...ruling.state, childStartedAt: T0 + (i + 1) * 10_000 };
    }
    expect(delays.slice(0, 5)).toEqual([1500, 3000, 6000, 12000, 24000]);
    expect(delays[7]).toBe(60_000); // 1500*2^6=96000 → cap

    // 存活 ≥ bootOk 的崩溃：退避归零
    const longLived = decideOnExit(policy, initialSupervisionState(T0), 1, null, T0 + 60_000);
    if (longLived.decision.action === 'restart') {
      expect(longLived.decision.delayMs).toBe(1500);
    }
  });

  it('熔断：窗口内达到 crashLimit → 退出', () => {
    let state = initialSupervisionState(T0);
    let last = { action: '' } as { action: string };
    for (let i = 0; i < POLICY.crashLimit; i++) {
      const ruling = decideOnExit(POLICY, state, 1, null, T0 + i * 1000 + 100);
      last = ruling.decision as { action: string };
      state = ruling.state;
    }
    expect(last.action).toBe('exit');
    // 窗口外崩溃不计：4 次崩溃后等窗口过再崩 → 不熔断
    let state2 = initialSupervisionState(T0);
    for (let i = 0; i < POLICY.crashLimit - 1; i++) {
      state2 = decideOnExit(POLICY, state2, 1, null, T0 + i * 1000 + 100).state;
    }
    const afterWindow = decideOnExit(POLICY, state2, 1, null, T0 + POLICY.crashWindowMs + 9999);
    expect(afterWindow.decision.action).toBe('restart');
  });

  it('signal 强杀走崩溃路径（code=null）', () => {
    const ruling = decideOnExit(POLICY, initialSupervisionState(T0), null, 'SIGKILL', T0 + 100);
    expect(ruling.decision.action).toBe('restart');
    if (ruling.decision.action === 'restart') {
      expect(ruling.decision.reason).toContain('SIGKILL');
    }
  });

  it('jitter：±ratio 扰动；ratio 0 不变', () => {
    expect(applyJitter(1000, 0)).toBe(1000);
    expect(applyJitter(1000, 0.2, () => 1)).toBe(1200);
    expect(applyJitter(1000, 0.2, () => 0)).toBe(800);
    expect(applyJitter(1000, 0.2, () => 0.5)).toBe(1000);
  });
});

describe('.runtime 单写者锁', () => {
  it('wx 排他创建：首获成功、二获拒绝、解锁后可重获', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-sup-'));
    const lockFile = runtimeLockPath(dir);
    const unlock = acquireRuntimeLock(lockFile);
    expect(() => acquireRuntimeLock(lockFile)).toThrow();
    unlock();
    const unlock2 = acquireRuntimeLock(lockFile); // 解锁后可重获
    unlock2();
    await rm(dir, { recursive: true, force: true });
  });

  it('陈旧锁回收（M16）：死 pid 残留文件 → 回收后重获', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-sup-'));
    const lockFile = runtimeLockPath(dir);
    // 模拟持有进程崩溃遗留：pid 为不存在的极大值（99999999 在 Windows/Linux 均无此进程）
    await writeFile(lockFile, JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));
    const unlock = acquireRuntimeLock(lockFile); // 陈旧 → 回收重试成功
    expect(() => acquireRuntimeLock(lockFile)).toThrow(); // 现在真被持有了
    unlock();
    await rm(dir, { recursive: true, force: true });
  });

  it('坏文件锁（不可解析）视为陈旧回收', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-sup-'));
    const lockFile = runtimeLockPath(dir);
    await writeFile(lockFile, 'stale-garbage');
    const unlock = acquireRuntimeLock(lockFile); // 读不了 → 视为陈旧可回收
    unlock();
    await rm(dir, { recursive: true, force: true });
  });

  it('存活 pid 的锁文件不回收（真实双启拒绝）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-sup-'));
    const lockFile = runtimeLockPath(dir);
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    expect(() => acquireRuntimeLock(lockFile)).toThrow(); // pid 存活（保守视为持有者仍活）
    await rm(dir, { recursive: true, force: true });
  });
});
