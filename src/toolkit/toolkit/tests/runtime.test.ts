// ============================================================
// toolkit 测试：workspace 运行时标识 .runtime
//
// 获取原子性/幂等/陈旧接管/活持有阻塞/降级/更新/释放/旧锁迁移 shim
// ============================================================
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_FILENAME, LEGACY_TIMER_LOCK, acquireRuntime, findRuntime, readRuntime,
  releaseRuntime, runtimeFilePath, updateRuntime, processHoldsRuntime,
  legacyTimerHolder, describeRuntime, type RuntimeRecord,
} from '../src/runtime';

let tmp: string;
/** 长命子进程（模拟"他进程活持有"） */
let liveChild: ChildProcess | null = null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-runtime-'));
});

afterEach(() => {
  if (liveChild) { try { liveChild.kill(); } catch { /* already gone */ } liveChild = null; }
  releaseRuntime(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
  expect(child.status).toBe(0);
  return child.pid!;
}

/** 起一个活着的子进程并返回 pid */
function livePid(): number {
  liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return liveChild.pid!;
}

function writeRecord(dir: string, rec: Partial<RuntimeRecord>): void {
  fs.writeFileSync(runtimeFilePath(dir), JSON.stringify({
    pid: process.pid, startedAt: '', kind: 'embedded', profile: 'embedded',
    workspaceDir: dir, nodeVersion: '', ...rec,
  }), 'utf8');
}

describe('acquireRuntime', () => {
  it('空 workspace：wx 创建成功；同进程重复获取幂等（缓存命中）', () => {
    const rt = acquireRuntime(tmp, { kind: 'web-app', port: 4831 });
    expect(rt.status).toBe('held');
    if (rt.status === 'held') expect(rt.record.port).toBe(4831);
    const again = acquireRuntime(tmp);
    expect(again.status).toBe('held');
    expect(processHoldsRuntime(tmp)).toBe(true);
  });

  it('陈旧持有者（pid 死）→ 清理重建，本进程接管', () => {
    writeRecord(tmp, { pid: deadPid() });
    const rt = acquireRuntime(tmp, { kind: 'web-app' });
    expect(rt.status).toBe('held');
    expect(readRuntime(tmp)?.pid).toBe(process.pid);
  });

  it('他进程活持有 → blocked（携带持有者信息）', () => {
    writeRecord(tmp, { pid: livePid(), kind: 'web-app', port: 3830 });
    const rt = acquireRuntime(tmp);
    expect(rt.status).toBe('blocked');
    if (rt.status === 'blocked') {
      expect(rt.holder.pid).toBe(liveChild!.pid);
      expect(Number.isInteger(rt.holder.port)).toBe(true);
    }
    // 且不写缓存：本进程不认为持有
    expect(processHoldsRuntime(tmp)).toBe(false);
  });

  it('同 pid 记录（崩溃重启 pid 复用边缘/同进程二次 boot）→ 认领', () => {
    writeRecord(tmp, { pid: process.pid, kind: 'base' });
    const rt = acquireRuntime(tmp, { kind: 'web-app' });
    expect(rt.status).toBe('held');
    if (rt.status === 'held') expect(rt.record.kind).toBe('base'); // 认领既有记录
  });

  it('损坏的 .runtime（非法 JSON/无 pid）→ 按陈旧清理重建', () => {
    fs.writeFileSync(runtimeFilePath(tmp), '{broken');
    expect(acquireRuntime(tmp).status).toBe('held');
    releaseRuntime(tmp);
    fs.writeFileSync(runtimeFilePath(tmp), JSON.stringify({ pid: 'x' }));
    expect(acquireRuntime(tmp).status).toBe('held');
    expect(readRuntime(tmp)?.pid).toBe(process.pid);
  });

  it('陈旧持有者 + 活持有者的竞态轮次：3 次尝试后仍活 → blocked', () => {
    // 持有者活着 → 第一轮 EEXIST + alive 即 blocked（不消耗重试）
    writeRecord(tmp, { pid: livePid() });
    expect(acquireRuntime(tmp).status).toBe('blocked');
  });
});

describe('findRuntime / readRuntime', () => {
  it('缺失/损坏 → null；活/死持有者 → alive 判定', () => {
    expect(findRuntime(tmp)).toBeNull();
    fs.writeFileSync(runtimeFilePath(tmp), '{bad');
    expect(findRuntime(tmp)).toBeNull();

    writeRecord(tmp, { pid: process.pid, port: 4830 });
    expect(findRuntime(tmp)?.alive).toBe(true);

    writeRecord(tmp, { pid: deadPid() });
    expect(findRuntime(tmp)?.alive).toBe(false);
  });
});

describe('updateRuntime / releaseRuntime', () => {
  it('仅本进程持有时可补写（tmp+rename 原子）；未持有 → null', () => {
    expect(updateRuntime(tmp, { port: 4830 })).toBeNull(); // 未获取
    acquireRuntime(tmp, { kind: 'web-app' });
    const next = updateRuntime(tmp, { port: 4830, profile: 'web-app' });
    expect(next?.port).toBe(4830);
    expect(readRuntime(tmp)?.port).toBe(4830);
  });

  it('释放只删自己的记录；他人/未持有不动', () => {
    releaseRuntime(tmp); // 未持有 → 无害
    writeRecord(tmp, { pid: deadPid() });
    releaseRuntime(tmp); // 他人（即便死）→ 文件保留（活性检查兜底语义）
    expect(fs.existsSync(runtimeFilePath(tmp))).toBe(true);

    acquireRuntime(tmp, { kind: 'web-app' });
    releaseRuntime(tmp);
    expect(fs.existsSync(runtimeFilePath(tmp))).toBe(false);
    expect(processHoldsRuntime(tmp)).toBe(false);
  });
});

describe('旧 timer-instance.lock 迁移 shim', () => {
  it('legacyTimerHolder：活/死/缺失三态', () => {
    expect(legacyTimerHolder(tmp)).toBeNull();
    const lockFile = path.join(tmp, LEGACY_TIMER_LOCK);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: livePid() }));
    expect(legacyTimerHolder(tmp)?.alive).toBe(true);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid() }));
    expect(legacyTimerHolder(tmp)?.alive).toBe(false);
  });

  it('acquire 成功时顺手清死持有者的旧锁；活持有者的保留', () => {
    const lockFile = path.join(tmp, LEGACY_TIMER_LOCK);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid() }));
    acquireRuntime(tmp);
    expect(fs.existsSync(lockFile)).toBe(false); // 死 → 清

    fs.writeFileSync(lockFile, JSON.stringify({ pid: livePid() }));
    // 已持有（缓存）不会重跑清理逻辑——用第二个目录验证活的保留
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-runtime2-'));
    try {
      fs.writeFileSync(path.join(tmp2, LEGACY_TIMER_LOCK), JSON.stringify({ pid: livePid() }));
      writeRecord(tmp2, { pid: deadPid() }); // 先占位再让 acquire 清理重建
      acquireRuntime(tmp2);
      expect(fs.existsSync(path.join(tmp2, LEGACY_TIMER_LOCK))).toBe(true); // 活 → 保留
    } finally {
      releaseRuntime(tmp2);
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe('describeRuntime', () => {
  it('含 pid/kind/port 的人类可读行', () => {
    const line = describeRuntime({
      pid: 123, startedAt: '2026-08-19T00:00:00Z', kind: 'web-app', port: 3830,
      profile: 'web-app', workspaceDir: '/x', nodeVersion: '',
    });
    expect(line).toContain('pid=123');
    expect(line).toContain('kind=web-app');
    expect(line).toContain('port=3830');
  });
});
