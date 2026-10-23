// ============================================================
// activation.lock 单测（M1.3 验收）：双进程互斥 / 死进程放锁 /
// 陈锁接管（stale-<bootId> 只留 1 个）/ 幂等释放 / 损坏锁自愈
// 数据根纪律：测试数据根恒 preview/sandbox/ 下独立目录
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  acquireActivationLock, releaseActivationLock, readActivationLock,
  type ActivationLockInfo,
} from '../src/lock.ts';

const ROOT = path.join('preview', 'sandbox', 'test-lock-' + process.pid);
let seq = 0;
const nextDir = () => path.join(ROOT, 'agent-' + (++seq));
const info = (pid: number, bootId: string): ActivationLockInfo => ({
  pid, bootId, acquiredAt: new Date().toISOString(), transportHint: '/sock/x',
});

beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('activation.lock：单进程语义', () => {
  it('获取成功：O_EXCL 创建 + 内容可回读', () => {
    const dir = nextDir();
    const r = acquireActivationLock(dir, info(100, 'b1'));
    expect(r.kind).toBe('acquired');
    expect(readActivationLock(dir)).toMatchObject({ pid: 100, bootId: 'b1' });
  });

  it('活进程持锁 → refused（fail-loud 单例语义）', () => {
    const dir = nextDir();
    acquireActivationLock(dir, info(process.pid, 'b1')); // 活 pid = 本测试进程
    const r = acquireActivationLock(dir, info(999, 'b2'));
    expect(r).toMatchObject({ kind: 'refused', holder: { pid: process.pid } });
  });

  it('释放幂等且删锁；无锁释放无异常', () => {
    const dir = nextDir();
    acquireActivationLock(dir, info(111, 'b1'));
    releaseActivationLock(dir, 111);
    releaseActivationLock(dir, 111);
    expect(readActivationLock(dir)).toBeNull();
  });

  it('他人已接管后不误删（释放只删自己的锁）', () => {
    const dir = nextDir();
    acquireActivationLock(dir, info(111, 'b1'));
    releaseActivationLock(dir, 222); // 假 pid 释放
    expect(readActivationLock(dir)).not.toBeNull(); // 111 的锁还在
  });

  it('死进程陈锁 → 接管 + stale-<bootId> 副本留证', () => {
    const dir = nextDir();
    acquireActivationLock(dir, info(999999, 'boot-old')); // 999999 大概率死
    const r = acquireActivationLock(dir, info(process.pid, 'boot-new'));
    expect(r.kind).toBe('acquired');
    expect(readActivationLock(dir)).toMatchObject({ bootId: 'boot-new' });
    expect(fs.existsSync(path.join(dir, 'activation.lock.stale-boot-old'))).toBe(true);
  });

  it('损坏锁（非 JSON）→ 视为陈锁接管自愈', () => {
    const dir = nextDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'activation.lock'), '{broken', 'utf-8');
    const r = acquireActivationLock(dir, info(process.pid, 'b1'));
    expect(r.kind).toBe('acquired');
    expect(fs.existsSync(path.join(dir, 'activation.lock.stale-unreadable'))).toBe(true);
  });

  it('多次接管只保留最新 1 个 stale 副本', () => {
    const dir = nextDir();
    acquireActivationLock(dir, info(999998, 'stale-1st'));
    acquireActivationLock(dir, info(999997, 'stale-2nd')); // 接管 1 → stale-1st 副本
    acquireActivationLock(dir, info(process.pid, 'live-3rd')); // 接管 2 → stale-2nd 副本，清 stale-1st
    const stales = fs.readdirSync(dir).filter((n) => n.startsWith('activation.lock.stale-'));
    expect(stales).toEqual(['activation.lock.stale-stale-2nd']);
  });
});

// 真子进程验收（plan 验收：双进程互斥 / 死进程放锁）
describe('activation.lock：跨进程验收', () => {
  it('活子进程持锁 → 主进程 refused；子进程死后 → 接管成功', async () => {
    const dir = nextDir();
    // 子进程：获取锁后挂住，stdout 通告就绪
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { acquireActivationLock } from ${JSON.stringify(new URL('../src/lock.ts', import.meta.url).href)};
      acquireActivationLock(process.argv[1], { pid: process.pid, bootId: 'child-boot', acquiredAt: new Date().toISOString(), transportHint: '/sock/child' });
      process.stdout.write('locked\\n');
      setInterval(() => {}, 1000);
    `, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (c: Buffer) => {
        buf += c.toString();
        if (buf.includes('locked')) resolve('locked');
      });
    });
    const state = await Promise.race([ready, new Promise<string>((r) => setTimeout(() => r('timeout'), 10_000))]);
    expect(state).toBe('locked');
    // 子进程活着 → 主进程拿不到
    expect(acquireActivationLock(dir, info(process.pid, 'main-boot')).kind).toBe('refused');
    // 杀死子进程（模拟崩溃——不跑任何 handler）
    const killed = await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      child.kill('SIGKILL');
    });
    await killed;
    // 子进程死后 → 主进程接管（陈锁自愈）
    const r = acquireActivationLock(dir, info(process.pid, 'main-boot'));
    expect(r.kind).toBe('acquired');
    expect(fs.existsSync(path.join(dir, 'activation.lock.stale-child-boot'))).toBe(true);
  }, 20_000);
});
