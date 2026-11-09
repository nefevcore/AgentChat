// ============================================================
// orchestrate-deadline.test.ts —— adoptShell stdout 消费循环常驻性
//（cr-580 根因回归锁：adopt deadline 只辖拉起窗——adopted 后循环退出
// 会使 ctrl.done/心跳行永无人分发：控制帧恒 60s 超时 + 监护失流。）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptShell } from '../orchestrate.ts';
import { ReachabilityTable } from 'ac-post-office';
import type { SpawnFn } from '../orchestrate.ts';

describe('adoptShell stdout 循环常驻性（cr-580）', () => {
  it('adopted 后超过 adopt deadline 的 ctrl.done 仍被分发（控制帧不超时）', async () => {
    const written: string[] = [];
    const lines: string[] = [
      'boot.lock.acquired\tb-1',
      'boot.rows.ready\tb-1\t31',
      'boot.ready\tb-1\\tpipe-x'.replace('\\t', '\t'),
    ];
    const waiters: Array<(l: string) => void> = [];
    const push = (l: string) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); };
    const spawnFn: SpawnFn = () => ({
      pid: 4321,
      stdout: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const queued = lines.shift();
            if (queued !== undefined) { yield queued; continue; }
            yield await new Promise<string>((resolve) => { waiters.push(resolve); });
          }
        },
      },
      write: (line: string) => {
        written.push(line);
        // 壳侧回执：等 adopt deadline（60ms）过后再吐行——修复前该行
        // 到达即循环退出、控制帧永挂
        setTimeout(() => push('ctrl.done\t{}'), 150);
      },
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => { void event; void cb; },
      kill: () => { /* 测试替身无进程 */ },
    });
    // 数据根用 tmpdir（adoptShell 会物化 agents/a1/config.json——相对路径
    // 会把残留写进仓库根，cr-621 实锤过 X/ 泄漏）
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-deadline-'));
    const adopted = await adoptShell({
      agentId: 'a1',
      dataRoot,
      catalogFile: 'C',
      bootFile: 'B',
      reach: new ReachabilityTable(),
      spawnFn,
      timeoutMs: 60, // deadline 60ms——回执在 150ms（>deadline）
    });
    expect(adopted.transportHint).toBe('pipe-x');
    const out = await adopted.control({ ctrl: 'admin', op: 'run-state', agentId: 'a1' });
    expect(out).toEqual({});
    expect(written).toHaveLength(1);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }, 20_000);
});

describe('adopt watchdog 独立定时器 + 分级预算（cr-962）', () => {
  it('壳完全静默（零 stdout 行）→ 到拍即杀——kill 不再寄生在行到达上', async () => {
    let killed = false;
    const spawnFn: SpawnFn = () => ({
      pid: 7777,
      stdout: {
        async *[Symbol.asyncIterator]() {
          // 永不出行（挂死壳——旧实现此形态永不触发 deadline 检查）
          await new Promise(() => {});
          yield ''; // unreachable
        },
      },
      write: () => {},
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => { void event; void cb; },
      kill: () => { killed = true; },
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-adopt-silent-'));
    const t0 = Date.now();
    try {
      await expect(adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn, timeoutMs: 80,
      })).rejects.toThrow(/adopt 超时.*已终止拉起中的壳进程/);
      expect(killed).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2_000); // 到拍即杀（非等行到达）
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('boot.* 节拍间慢但有进度 → 每拍预算重挂，慢启动不误杀', async () => {
    const spawnFn: SpawnFn = () => ({
      pid: 7778,
      stdout: {
        async *[Symbol.asyncIterator]() {
          // 每拍间隔 60ms——单拍预算 150ms 内有下一节拍即续命；三拍后 adopted
          await new Promise((r) => setTimeout(r, 60));
          yield 'boot.lock.acquired\tb-1';
          await new Promise((r) => setTimeout(r, 60));
          yield 'boot.rows.ready\tb-1\t12';
          await new Promise((r) => setTimeout(r, 60));
          yield 'boot.ready\tb-1\tpipe-slow';
          for (;;) await new Promise(() => {});
        },
      },
      write: () => {},
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => { void event; void cb; },
      kill: () => {},
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-adopt-slow-'));
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn, timeoutMs: 150,
      });
      expect(adopted.transportHint).toBe('pipe-slow');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('adopt 超时终止拉起中进程（cr-805 幽灵持锁根修）', () => {
  it('deadline 超时 → kill 子进程 + 拒绝（不留持 activation.lock 的幽灵）', async () => {
    let killed = false;
    const spawnFn: SpawnFn = () => ({
      pid: 9999,
      stdout: {
        async *[Symbol.asyncIterator]() {
          // 慢 boot：只吐非 boot 节拍行（驱动 deadline 检查——检查点在每行 stdout）
          for (;;) {
            await new Promise((r) => setTimeout(r, 20));
            yield 'guardian.ping\tT';
          }
        },
      },
      write: () => {},
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => { void event; void cb; },
      kill: () => { killed = true; },
    });
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-adopt-timeout-'));
    try {
      await expect(adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn, timeoutMs: 60,
      })).rejects.toThrow(/adopt 超时.*已终止拉起中的壳进程/);
      expect(killed).toBe(true); // 幽灵源头消灭
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 10_000);
});