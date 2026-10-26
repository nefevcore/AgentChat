// ============================================================
// host-revive 单测（D5 边 2 常态化，cr-612）：纯域 tick 语义——
// 失联确认 / 停机戳 stand down / O_EXCL 仲裁 / 退避档 / 恢复复位 +
// startHostRevive 真实装配的锁物理面。
// 数据根纪律：恒 sandbox/ 独立目录。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createHostReviveState, tickHostRevive, reviveBackoffMs, startHostRevive,
  hostStampPath, hostReviveLockPath, spawnHostProcess, type HostReviveDeps,
} from '../host-revive.ts';

const ROOT = path.join('sandbox', 'test-host-revive-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

interface Fake {
  deps: HostReviveDeps;
  probes: Array<() => Promise<boolean>>;
  spawns: number;
  lockHeld: boolean;
  lockCalls: number;
  stamp: boolean;
  signals: string[];
  clock: number;
}

function makeFake(overrides: Partial<{ stamp: boolean; lockHeld: boolean }> = {}): Fake {
  const fake: Fake = {
    probes: [],
    spawns: 0,
    lockHeld: overrides.lockHeld === true,
    lockCalls: 0,
    stamp: overrides.stamp === true,
    signals: [],
    clock: 1_000,
    deps: undefined as unknown as HostReviveDeps,
  };
  fake.deps = {
    probe: () => (fake.probes.length > 0 ? fake.probes.shift()!() : Promise.resolve(true)),
    stampPresent: () => fake.stamp,
    tryLock: () => { fake.lockCalls += 1; return !fake.lockHeld; },
    unlock: () => { fake.lockHeld = false; },
    spawnHost: () => { fake.spawns += 1; },
    emit: (signal) => { fake.signals.push(signal); },
    now: () => fake.clock,
  };
  return fake;
}

const down = () => Promise.resolve(false);
const up = () => Promise.resolve(true);

describe('tickHostRevive 纯域', () => {
  it('宿主在（探测成功）：不复活；由失联恢复时发 host.revived 并复位退避', async () => {
    const fake = makeFake();
    const state = createHostReviveState(fake.clock);
    await tickHostRevive(state, fake.deps); // up
    expect(fake.spawns).toBe(0);
    // 制造一次失联 → 再恢复
    fake.probes.push(down, down, up);
    await tickHostRevive(state, fake.deps);
    await tickHostRevive(state, fake.deps);
    await tickHostRevive(state, fake.deps);
    expect(fake.signals).toContain('host.revive.attempt');
    await tickHostRevive(state, fake.deps); // up → revived
    expect(fake.signals).toContain('host.revived');
    expect(state.attempts).toBe(0);
    expect(state.down).toBe(false);
  });

  it('连续失败达阈值才判失联（首败不动）；失联即拉起一次并进入退避', async () => {
    const fake = makeFake();
    const state = createHostReviveState(fake.clock);
    fake.probes.push(down);
    await tickHostRevive(state, fake.deps);
    expect(fake.spawns).toBe(0); // 首败未达阈值
    fake.probes.push(down, down);
    await tickHostRevive(state, fake.deps); // 第 2 败 → 拉起
    expect(fake.spawns).toBe(1);
    expect(fake.signals).toContain('host.revive.attempt');
    await tickHostRevive(state, fake.deps); // 退避窗内 → 不再拉
    expect(fake.spawns).toBe(1);
  });

  it('停机戳在场 = stand down：不拉起、只发一次信号；戳缺席后恢复职责', async () => {
    const fake = makeFake({ stamp: true });
    const state = createHostReviveState(fake.clock);
    fake.probes.push(down, down, down);
    await tickHostRevive(state, fake.deps);
    await tickHostRevive(state, fake.deps);
    await tickHostRevive(state, fake.deps);
    expect(fake.spawns).toBe(0);
    expect(fake.signals.filter((s) => s === 'host.revive.standdown')).toHaveLength(1);
    fake.stamp = false; // 宿主 boot 清戳（换代完成）
    fake.clock += 10_000; // 过退避窗
    fake.probes.push(down);
    await tickHostRevive(state, fake.deps);
    expect(fake.spawns).toBe(1);
  });

  it('仲裁锁被他壳持有：不拉起（等探测面恢复）', async () => {
    const fake = makeFake({ lockHeld: true });
    const state = createHostReviveState(fake.clock);
    fake.probes.push(down, down);
    await tickHostRevive(state, fake.deps);
    await tickHostRevive(state, fake.deps);
    expect(fake.spawns).toBe(0);
    expect(fake.lockCalls).toBe(1);
  });

  it('supervised 让路窗（cr-647）：失联确认后宽限内不拉起，宽限过才拉', async () => {
    const fake = makeFake();
    const state = createHostReviveState(fake.clock);
    const config = { reviveGraceMs: 10_000 };
    fake.probes.push(down);
    await tickHostRevive(state, fake.deps, config); // 首败
    fake.probes.push(down);
    await tickHostRevive(state, fake.deps, config); // 确认失联 → 宽限内
    expect(fake.spawns).toBe(0);
    fake.clock += 9_000;
    fake.probes.push(down);
    await tickHostRevive(state, fake.deps, config);
    expect(fake.spawns).toBe(0); // 宽限未过（9s < 10s）
    fake.clock += 1_000;
    fake.probes.push(down);
    await tickHostRevive(state, fake.deps, config);
    expect(fake.spawns).toBe(1); // 宽限过 → supervisor 快路未接管才兜底
  });

  it('退避指数增长有 cap', () => {
    expect(reviveBackoffMs(1_500, 60_000, 0, () => 0.5)).toBe(1_500);
    expect(reviveBackoffMs(1_500, 60_000, 5, () => 0.5)).toBe(48_000);
    expect(reviveBackoffMs(1_500, 60_000, 20, () => 0.5)).toBe(60_000); // cap
  });
});

describe('startHostRevive 真实装配（锁物理面）', () => {
  it('O_EXCL 锁：两执行者并发只一个持锁；stop 释放', async () => {
    const opts = {
      postOffice: '\\\\./pipe/agentchat-test-revive-' + process.pid,
      dataRoot: ROOT,
      hostBoot: 'x/boot.ts',
      probeIntervalMs: 60_000, // 不让 interval 真跑——物理面单测
    };
    const a = startHostRevive(opts);
    const lockPath = hostReviveLockPath(ROOT);
    // 手工占锁（模拟另一壳）→ a 的 tryLock 必败
    fs.writeFileSync(lockPath, 'other');
    const state = createHostReviveState(0);
    let spawned = 0;
    const deps: HostReviveDeps = {
      probe: down,
      stampPresent: () => false,
      tryLock: () => { try { fs.openSync(lockPath, 'wx'); return true; } catch { return false; } },
      unlock: () => { fs.rmSync(lockPath, { force: true }); },
      spawnHost: () => { spawned += 1; },
      emit: () => {},
      now: () => 0,
    };
    await tickHostRevive(state, deps);
    await tickHostRevive(state, deps);
    expect(spawned).toBe(0); // 锁被他者持有
    fs.rmSync(lockPath, { force: true });
    await tickHostRevive(state, deps);
    expect(spawned).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false); // 拉完即释放
    a.stop();
    expect(fs.existsSync(hostStampPath(ROOT))).toBe(false);
  });
});

describe('cr-662 复活宿主 stderr 落日志（物理面）', () => {
  it('spawnHostProcess：宿主 stderr 落 host-revive-<ts>.log（不再 stdio ignore 零现场）', async () => {
    const dir = path.join(ROOT, 'revive-log');
    fs.mkdirSync(dir, { recursive: true });
    const boot = path.join(dir, 'boom.ts');
    fs.writeFileSync(boot, "process.stderr.write('host-boom\\n'); process.exit(1);\n");
    spawnHostProcess(boot, dir);
    const logsDir = path.join(dir, '.runtime', 'logs');
    const deadline = Date.now() + 15_000;
    for (;;) {
      const hit = fs.existsSync(logsDir) && fs.readdirSync(logsDir).some((n) => {
        try { return fs.readFileSync(path.join(logsDir, n), 'utf-8').includes('host-boom'); } catch { return false; }
      });
      if (hit || Date.now() > deadline) {
        expect(hit).toBe(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 25_000);
});

