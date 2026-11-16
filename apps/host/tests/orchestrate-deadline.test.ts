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
import { acquireActivationLock, releaseActivationLock, listenIpc, socketPathFor, isManageRequest, makeManageReply } from 'ac-envelope-core';
import { ReachabilityTable } from 'ac-post-office';
import type { SpawnFn } from '../orchestrate.ts';

describe('adoptShell 判据与控制面（cr-580 → cr-1129 批4：探测面唯一判据）', () => {
  it('adopted 后慢回执控制帧仍往返成功（manage 通道不受拉起窗辖制）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-deadline-'));
    const agentDir = path.join(dataRoot, 'agents', 'a1');
    const hint = socketPathFor(path.resolve(dataRoot), 'a1');
    acquireActivationLock(agentDir, { pid: 4321, bootId: 'b-1', acquiredAt: new Date().toISOString(), transportHint: hint });
    // 壳侧 manage 面：150ms 慢回执（> 旧 adopt deadline 语义面——拉起窗已收）
    const server = await listenIpc(hint, (payload) => new Promise((resolve) => {
      setTimeout(() => {
        if (isManageRequest(payload)) resolve(makeManageReply(payload.manage.id, { ok: true, value: { echoed: true } }));
        else resolve(undefined);
      }, 150);
    }));
    const spawnFn: SpawnFn = () => ({
      pid: 4321,
      stdout: { async *[Symbol.asyncIterator]() { for (;;) yield await new Promise<string>(() => {}); } },
      write: () => { throw new Error('stdin 写点不得触达'); },
      on: () => {},
      kill: () => {},
    });
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn,
      });
      expect(adopted.transportHint).toBe(hint);
      const out = await adopted.control({ ctrl: 'admin', op: 'run-state', agentId: 'a1' });
      expect(out).toEqual({ echoed: true });
    } finally {
      releaseActivationLock(agentDir, 4321);
      await server.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('慢启动容忍（cr-962 分级预算 → 探测面形态）', () => {
  it('锁/ipc 晚到（200ms）但预算内 → adopt 成功（有节拍的慢，不该死）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-adopt-slow-'));
    const agentDir = path.join(dataRoot, 'agents', 'a1');
    const hint = socketPathFor(path.resolve(dataRoot), 'a1');
    const late = (async () => {
      await new Promise((r) => setTimeout(r, 200));
      acquireActivationLock(agentDir, { pid: 4321, bootId: 'b-slow', acquiredAt: new Date().toISOString(), transportHint: hint });
      return listenIpc(hint, () => undefined);
    })();
    const spawnFn: SpawnFn = () => ({
      pid: 4321,
      stdout: { async *[Symbol.asyncIterator]() { for (;;) yield await new Promise<string>(() => {}); } },
      write: () => {},
      on: () => {},
      kill: () => {},
    });
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn, timeoutMs: 2_000,
      });
      expect(adopted.transportHint).toBe(hint);
      (await late).close();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 15_000);
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