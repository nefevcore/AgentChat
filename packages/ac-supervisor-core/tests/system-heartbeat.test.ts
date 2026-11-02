// ============================================================
// system-heartbeat.test.ts —— system 心跳双证据单测（cr-859 §五.2）
// 数据根纪律：恒 sandbox/ 独立目录。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  initSystemHeartbeat, touchSystemHeartbeat, probeSystemAlive,
  systemHeartbeatPath, SYSTEM_HEARTBEAT_FRESH_MS,
} from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-sys-hb-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 真活锁（写本进程 pid——双证据之一起点）。锁是文件（与生产同形态
 * ——runtimeLockPath 返回文件路径），心跳住 .runtime/ 目录内。 */
function liveLock(): string {
  const lock = path.join(ROOT, 'runtime.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  return lock;
}

describe('system 心跳面', () => {
  it('双证据全真 = alive（pid 活 ∧ 心跳新鲜）', () => {
    const lock = liveLock();
    const t0 = 1_000_000;
    initSystemHeartbeat(ROOT, t0);
    const p = probeSystemAlive(lock, ROOT, t0 + 1_000);
    expect(p.alive).toBe(true);
    expect(p.lockPidAlive).toBe(true);
    expect(p.heartbeatFresh).toBe(true);
  });

  it('pid 证据假（锁缺席）= 不 alive——心跳再新也不够', () => {
    initSystemHeartbeat(ROOT, 1_000_000);
    const p = probeSystemAlive(path.join(ROOT, 'runtime.lock'), ROOT, 1_001_000);
    expect(p.alive).toBe(false);
    expect(p.lockPresent).toBe(false);
  });

  it('pid 证据假（锁内 pid 死）= 不 alive', () => {
    const lock = path.join(ROOT, 'runtime.lock');
    // 极大 pid：本机不可能是活进程（pid 空间上限量级）
    fs.writeFileSync(lock, JSON.stringify({ pid: 4_000_000 }));
    initSystemHeartbeat(ROOT, 1_000_000);
    const p = probeSystemAlive(lock, ROOT, 1_001_000);
    expect(p.alive).toBe(false);
    expect(p.lockPidAlive).toBe(false);
    expect(p.heartbeatFresh).toBe(true); // 心跳证据单独为真不救场
  });

  it('心跳证据假（mtime 老化超窗）= 不 alive——覆盖挂起场景', () => {
    const lock = liveLock();
    const now = Date.now();
    initSystemHeartbeat(ROOT, now);
    // 真实墙钟外拨 mtime 到新鲜窗外（init 的 now 参数只写内容不写 mtime——
    // 落盘 mtime 恒真实时刻，故手动 utimes 拨旧模拟挂起停止 touch）
    fs.utimesSync(systemHeartbeatPath(ROOT), new Date(now - SYSTEM_HEARTBEAT_FRESH_MS - 5_000), new Date(now - SYSTEM_HEARTBEAT_FRESH_MS - 5_000));
    const p = probeSystemAlive(lock, ROOT, now);
    expect(p.alive).toBe(false);
    expect(p.lockPidAlive).toBe(true); // pid 还活（挂起）
    expect(p.heartbeatFresh).toBe(false);
  });

  it('心跳文件缺席 = 不 alive（system 从未运行）', () => {
    const lock = liveLock();
    const p = probeSystemAlive(lock, ROOT, 1_000_000);
    expect(p.alive).toBe(false);
    expect(p.heartbeatFresh).toBe(false);
  });

  it('touch 续期：mtime 前移恢复新鲜', async () => {
    const lock = liveLock();
    const t0 = 1_000_000;
    initSystemHeartbeat(ROOT, t0);
    // 模拟老化的实际等待路径：真实时间前移（init 写入的真实 mtime）—等一小段后 touch
    touchSystemHeartbeat(ROOT);
    const p = probeSystemAlive(lock, ROOT, Date.now());
    expect(p.heartbeatFresh).toBe(true);
  });

  it('touch 缺席文件重建（tmp 清扫场景）', () => {
    const lock = liveLock();
    fs.rmSync(systemHeartbeatPath(ROOT), { force: true });
    touchSystemHeartbeat(ROOT);
    expect(fs.existsSync(systemHeartbeatPath(ROOT))).toBe(true);
    expect(probeSystemAlive(lock, ROOT, Date.now()).heartbeatFresh).toBe(true);
  });
});
