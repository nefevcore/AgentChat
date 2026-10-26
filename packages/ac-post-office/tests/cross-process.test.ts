// ============================================================
// M4.4 级联验收（D9 步 3）：跨进程投递跑通。
// 测试进程 = 宿主（邮局路由 + 可达表）；真子进程 = 壳接收端
//（shell-receiver.helper.ts）。三验收：跨进程 1v1 / 群播扇出 /
// 崩溃陈锁接管续跑。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeEnvelope, socketPathFor,
  acquireActivationLock, readActivationLock,
} from 'ac-envelope-core';
import {
  ConversationRegistry, ReachabilityTable, routeEnvelope, IpcClient,
} from '../src/index.ts';

const ROOT = path.join('sandbox', 'test-xproc-' + process.pid);
const HELPER = fileURLToPath(new URL('./shell-receiver.helper.ts', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function agentPaths(agentId: string): { sock: string; dir: string } {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  // socketPathFor：posix = <dataRoot>/ipc/<id>.sock；win32 自动映射 named pipe
  const sock = socketPathFor(path.resolve(ROOT), agentId);
  return { sock, dir };
}

// 收割兜底（2026-10-17 事故防复发）：spawn 的 helper 进程统一登记，
// afterEach 按精确 pid kill——绝不扫进程表（宿主同 node 形态，子串匹配必误伤）。
const spawned: ChildProcess[] = [];

async function spawnReceiver(agentId: string): Promise<{ child: ChildProcess; sock: string; dir: string }> {
  const { sock, dir } = agentPaths(agentId);
  const child = spawn(process.execPath, ['--experimental-strip-types', HELPER, sock, dir.replaceAll('\\', '/')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  spawned.push(child);
  await new Promise<void>((resolve) => {
    child.stdout.on('data', (c: Buffer) => { if (c.toString().includes('ready')) resolve(); });
  });
  return { child, sock, dir };
}

function readReceived(dir: string): Array<{ requestId: string; fresh: boolean; sender: string; text: string }> {
  try {
    return fs.readFileSync(path.join(dir, 'received.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('M4.4 级联验收：跨进程投递', () => {
  it('① 1v1：user 经邮局投 alpha（跨进程投递 + 幂等 + ack）', async () => {
    const alpha = await spawnReceiver('alpha');
    try {
      const reach = new ReachabilityTable();
      reach.markReachable('alpha', alpha.sock);
      const env = makeEnvelope({
        uuid: 'u-xproc', requestId: 'req-a', sender: 'user', to: 'alpha',
        payload: { text: '跨进程你好' },
      });
      const instructions = routeEnvelope(env, { registry: new ConversationRegistry(), reach });
      expect(instructions).toHaveLength(1);
      const direct = instructions[0];
      expect(direct.channel).toBe('direct');
      const client = new IpcClient();
      await client.connect(alpha.sock);
      const ack = await client.send(direct.channel === 'direct' ? direct.envelope : null);
      expect(ack).toEqual({ ack: 'req-a', fresh: true });
      const ack2 = await client.send(env);
      expect(ack2).toEqual({ ack: 'req-a', fresh: false });
      expect(readReceived(alpha.dir)).toHaveLength(1);
      expect(readReceived(alpha.dir)[0]).toMatchObject({ sender: 'user', text: '跨进程你好' });
      client.close();
    } finally {
      alpha.child.kill();
    }
  }, 30_000);

  it('② 群播扇出：group 地址 → 两成员各收一封（跳过发送方）', async () => {
    const alpha = await spawnReceiver('alpha');
    const beta = await spawnReceiver('beta');
    try {
      const reach = new ReachabilityTable();
      reach.markReachable('alpha', alpha.sock);
      reach.markReachable('beta', beta.sock);
      const env = makeEnvelope({
        uuid: 'u-group', requestId: 'req-g', sender: 'user', to: 'group-team',
        payload: { text: '群播' },
      });
      const instructions = routeEnvelope(env, {
        registry: new ConversationRegistry(), reach,
        multicast: { membersOf: (a: string) => a === 'group-team' ? ['user', 'alpha', 'beta'] : undefined },
      });
      expect(instructions).toHaveLength(2);
      const c1 = new IpcClient(); await c1.connect(alpha.sock);
      const c2 = new IpcClient(); await c2.connect(beta.sock);
      for (const inst of instructions) {
        if (inst.channel !== 'direct') continue;
        const client = inst.to === 'alpha' ? c1 : c2;
        expect(await client.send(inst.envelope)).toMatchObject({ ack: 'req-g', fresh: true });
      }
      c1.close(); c2.close();
      expect(readReceived(alpha.dir)).toHaveLength(1);
      expect(readReceived(beta.dir)).toHaveLength(1);
    } finally {
      alpha.child.kill(); beta.child.kill();
    }
  }, 30_000);

  it('③ 崩溃接管续跑：SIGKILL 壳 → 陈锁 → 新壳接管续跑', async () => {
    const { dir, sock } = agentPaths('gamma');
    const lock1 = acquireActivationLock(dir, {
      pid: 999_999_999, bootId: 'old-boot', acquiredAt: 'T', transportHint: sock, // 不存在的大 pid = 确定死
    });
    expect(lock1.kind).toBe('acquired');
    const lock2 = acquireActivationLock(dir, {
      pid: process.pid, bootId: 'new-boot', acquiredAt: 'T2', transportHint: sock,
    });
    expect(lock2.kind).toBe('acquired');
    expect(readActivationLock(dir)).toMatchObject({ bootId: 'new-boot' });
    expect(fs.existsSync(path.join(dir, 'activation.lock.stale-old-boot'))).toBe(true);
    const gamma = await spawnReceiver('gamma');
    try {
      const client = new IpcClient();
      await client.connect(gamma.sock);
      const env = makeEnvelope({
        uuid: 'u-takeover', requestId: 'req-t', sender: 'user', to: 'gamma',
        payload: { text: '接管后续跑' },
      });
      expect(await client.send(env)).toMatchObject({ ack: 'req-t', fresh: true });
      expect(readReceived(gamma.dir)).toHaveLength(1);
      client.close();
    } finally {
      gamma.child.kill();
    }
  }, 30_000);
});
