// ============================================================
// data-root-lock.test.ts —— 数据根独占锁语义
//
// 覆盖：获锁/释放幂等、活进程持锁拒绝（fail-loud）、陈旧锁回收、
// 同进程复入（重写刷新）、释放后他人可接手。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataRootLock } from '../src/data-root-lock.ts';

let tmp = '';

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

function fresh(): string {
  tmp = mkdtempSync(join(tmpdir(), 'ac-lock-'));
  return tmp;
}

describe('数据根独占锁', () => {
  it('获锁写身份文件，释放删除且幂等', () => {
    const root = fresh();
    const release = acquireDataRootLock(root, { pid: 101, now: 123 });
    const file = join(root, '.data-root.lock');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ pid: 101, bootMs: 123 });
    release();
    release(); // 幂等
    expect(existsSync(file)).toBe(false);
  });

  it('活进程持锁 → 抛错 fail-loud（消息含持锁 pid 与根路径）', () => {
    const root = fresh();
    // pid 4 = Windows System 进程 / Unix root 常驻——恒活且非自身
    writeFileSync(join(root, '.data-root.lock'), JSON.stringify({ pid: 4, bootMs: 1 }));
    expect(() => acquireDataRootLock(root, { pid: 999 })).toThrow(/进程 4/);
    expect(() => acquireDataRootLock(root, { pid: 999 })).toThrow(new RegExp(root.replace(/\\/g, '\\\\').replace(/\//g, '\\/')));
  });

  it('陈旧锁（持锁进程已死）→ 回收重写获锁', () => {
    const root = fresh();
    // pid 取值远离任何活进程区间（Windows allocate/free 后回收的大数值空段）
    writeFileSync(join(root, '.data-root.lock'), JSON.stringify({ pid: 1_900_000_000, bootMs: 1 }));
    const release = acquireDataRootLock(root, { pid: 501, now: 456 });
    expect(JSON.parse(readFileSync(join(root, '.data-root.lock'), 'utf-8'))).toEqual({ pid: 501, bootMs: 456 });
    release();
  });

  it('同进程复入 → 允许（首获身份保持，计数管理）；损坏锁文件视为无锁', () => {
    const root = fresh();
    const r1 = acquireDataRootLock(root, { pid: 701, now: 1 });
    const r2 = acquireDataRootLock(root, { pid: 701, now: 2 });
    // 复入不重写身份（首获 bootMs 保持）——引用计数语义
    expect(JSON.parse(readFileSync(join(root, '.data-root.lock'), 'utf-8'))).toEqual({ pid: 701, bootMs: 1 });
    r1();
    // r1 释放后计数仍 > 0（r2 持有）——早卸载 Fiber 不拆在跑实例的锁
    expect(existsSync(join(root, '.data-root.lock'))).toBe(true);
    r2();
    expect(existsSync(join(root, '.data-root.lock'))).toBe(false);

    writeFileSync(join(root, '.data-root.lock'), 'not-json{');
    const r3 = acquireDataRootLock(root, { pid: 701, now: 3 });
    r3();
  });

  it('释放后其他 pid 可接手；接手后原释放函数不误删他人锁', () => {
    const root = fresh();
    const file = join(root, '.data-root.lock');
    const rA = acquireDataRootLock(root, { pid: 801, now: 1 });
    rA();
    const rB = acquireDataRootLock(root, { pid: 802, now: 2 });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ pid: 802, bootMs: 2 });
    rA(); // 迟到的旧释放：锁已归 802，不得删除
    expect(existsSync(file)).toBe(true);
    rB();
  });
});
