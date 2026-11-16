// ============================================================
// orchestrate-off-stdio.test.ts —— adopt 探测面判据（cr-1125 批 1：
// shell-protocol-off-stdio-plan §三 批 1，V1 前半——零 stdout 行形态下
// 锁 / progress / probeIpc 三事件驱动 adopt；与行流判据并存不互斥）。
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adoptShell } from '../orchestrate.ts';
import { ReachabilityTable } from 'ac-post-office';
import { acquireActivationLock, releaseActivationLock, writeBootProgress, listenIpc, socketPathFor, isManageRequest, makeManageReply } from 'ac-envelope-core';
import type { SpawnFn } from '../orchestrate.ts';

/** 零 stdout 行的假壳（off-stdio 形态——行流判据无从触发） */
const silentSpawn: SpawnFn = () => ({
  pid: 4321,
  stdout: {
    async *[Symbol.asyncIterator]() {
      for (;;) yield await new Promise<string>(() => { /* 永静默 */ });
    },
  },
  write: () => { /* stdin 无人读 */ },
  on: () => { /* 不退出 */ },
  kill: () => { /* 测试替身无进程 */ },
});

/** 假壳自举：写锁（本代 pid）+ 起 ipc 监听（probeIpc 判据的实连目标） */
function fakeShellBoot(dataRoot: string, agentId: string, bootId: string): Promise<{ close(): Promise<void> }> {
  const agentDir = path.join(dataRoot, 'agents', agentId);
  const hint = socketPathFor(path.resolve(dataRoot), agentId);
  const lock = acquireActivationLock(agentDir, {
    pid: 4321, bootId, acquiredAt: new Date().toISOString(), transportHint: hint,
  });
  if (lock.kind === 'refused') throw new Error('测试锁冲突：' + lock.holder.bootId);
  return listenIpc(hint, () => undefined).then((server) => ({
    close: async () => {
      releaseActivationLock(agentDir, 4321);
      await server.close();
    },
  }));
}

describe('adopt 探测面判据（cr-1125 → cr-1129 批4：唯一判据——门控退役）', () => {

  it('零 stdout 行：锁 + progress + probeIpc 实连 → adopted（rows/fingerprint 随行）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offstdio-'));
    const server = await fakeShellBoot(dataRoot, 'a1', 'boot-1');
    writeBootProgress(path.join(dataRoot, 'agents', 'a1'), {
      bootId: 'boot-1', writtenAt: new Date().toISOString(), rows: 29, fingerprintRoot: 'sha-root-1',
    });
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn: silentSpawn, timeoutMs: 15_000,
      });
      expect(adopted.bootId).toBe('boot-1');
      expect(adopted.transportHint).toBe(socketPathFor(path.resolve(dataRoot), 'a1'));
      const rowsReady = adopted.events.find((e) => e.type === 'rows-ready');
      expect(rowsReady).toMatchObject({ rows: 29 });
      expect(adopted.events.find((e) => e.type === 'adopted')).toMatchObject({ fingerprintRoot: 'sha-root-1' });
    } finally {
      await server.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 25_000);

  it('progress 代际不匹配（上代残留）不采信——adopted 无 fingerprintRoot、无 rows-ready', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offstdio-'));
    const server = await fakeShellBoot(dataRoot, 'a1', 'boot-2');
    writeBootProgress(path.join(dataRoot, 'agents', 'a1'), {
      bootId: 'boot-stale', writtenAt: new Date().toISOString(), rows: 99, fingerprintRoot: 'sha-stale',
    });
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn: silentSpawn, timeoutMs: 15_000,
      });
      expect(adopted.bootId).toBe('boot-2');
      expect(adopted.events.find((e) => e.type === 'rows-ready')).toBeUndefined();
      expect((adopted.events.find((e) => e.type === 'adopted') as { fingerprintRoot?: string }).fingerprintRoot).toBeUndefined();
    } finally {
      await server.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 25_000);

  it('progress 缺席（批 2 前的现存壳形态）→ 锁 + probeIpc 仍可达 adopt（并存兼容）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offstdio-'));
    const server = await fakeShellBoot(dataRoot, 'a1', 'boot-3');
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn: silentSpawn, timeoutMs: 15_000,
      });
      expect(adopted.bootId).toBe('boot-3');
      expect(adopted.events.find((e) => e.type === 'adopted')).toMatchObject({ agentId: 'a1' });
    } finally {
      await server.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 25_000);

  it('锁 pid 非本代（上代残留锁）→ 不误判（watchdog 到拍即杀）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offstdio-'));
    const agentDir = path.join(dataRoot, 'agents', 'a1');
    fs.mkdirSync(agentDir, { recursive: true });
    // 上代锁：pid 111（≠ 假壳 4321）——探测面必须不认
    acquireActivationLock(agentDir, {
      pid: 111, bootId: 'boot-old', acquiredAt: new Date().toISOString(),
      transportHint: socketPathFor(path.resolve(dataRoot), 'a1'),
    });
    await expect(adoptShell({
      agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
      reach: new ReachabilityTable(), spawnFn: silentSpawn, timeoutMs: 300,
    })).rejects.toThrow('adopt 超时');
    releaseActivationLock(agentDir, 111);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }, 20_000);

  it('V4：控制帧走 manage 通道往返 + shutdown 帧（stdin 帧路径无人用）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offstdio-'));
    const agentDir = path.join(dataRoot, 'agents', 'a1');
    const hint = socketPathFor(path.resolve(dataRoot), 'a1');
    acquireActivationLock(agentDir, { pid: 4321, bootId: 'boot-5', acquiredAt: new Date().toISOString(), transportHint: hint });
    let exitCb: ((code: number | null, signal: string | null) => void) | null = null;
    // manage 假壳：echo 控制帧；system/shutdown → 触发 exit 面
    const server = await listenIpc(hint, (payload) => {
      if (!isManageRequest(payload)) return undefined;
      if (payload.manage.frame.ctrl === 'system' && payload.manage.frame.op === 'shutdown') {
        setTimeout(() => exitCb?.(0, null), 10);
        return makeManageReply(payload.manage.id, { ok: true, value: { ok: true } });
      }
      return makeManageReply(payload.manage.id, { ok: true, value: { echo: payload.manage.frame } });
    });
    const spawnFn: SpawnFn = () => ({
      pid: 4321,
      stdout: { async *[Symbol.asyncIterator]() { for (;;) yield await new Promise<string>(() => {}); } },
      write: () => { throw new Error('stdin 写点不得触达（V4：控制帧零 stdin 面）'); },
      on: (_e, cb) => { exitCb = cb; },
      kill: () => { /* 测试替身 */ },
    });
    try {
      const adopted = await adoptShell({
        agentId: 'a1', dataRoot, catalogFile: 'C', bootFile: 'B',
        reach: new ReachabilityTable(), spawnFn, timeoutMs: 15_000,
      });
      const out = await adopted.control({ ctrl: 'admin', op: 'run-state', agentId: 'a1' });
      expect(out).toEqual({ echo: { ctrl: 'admin', op: 'run-state', agentId: 'a1' } });
      const code = await adopted.shutdown();
      expect(code).toBe(0);
    } finally {
      releaseActivationLock(agentDir, 4321);
      await server.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 25_000);

});
