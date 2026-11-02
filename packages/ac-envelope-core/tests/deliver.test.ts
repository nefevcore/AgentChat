// ============================================================
// deliver.test.ts —— 对等投递双层会合测试（cr-861）
// 覆盖：活体直投（真 ipc listener）/ 无锁落 inbox（原子写 + 文件名
// 即幂等键）/ 陈锁降级（锁在但连不上 → 落 inbox 不抛错）/ 回程对称。
// 数据根恒 sandbox 独立目录（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireActivationLock, listenIpc, makeEnvelope, socketPathFor, type Envelope } from '../src/index.ts';
import { deliver, type RendezvousPaths } from '../src/deliver.ts';

const ROOT = path.resolve('sandbox', 'test-deliver-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** 会合寻址面（测试拓扑：agents/<id>/——主线同款路径代数） */
const paths: RendezvousPaths = {
  agentDirOf: (ep) => path.join(ROOT, 'agents', ep),
  sessionDirOf: (ep, conv) => path.join(ROOT, 'agents', ep, 'sessions', conv),
};

function env(init: Partial<Envelope> = {}): Envelope {
  return makeEnvelope({
    uuid: init.uuid ?? 'u-deliver',
    requestId: init.requestId ?? 'rq-' + Math.random().toString(36).slice(2),
    sender: init.sender ?? 'alpha',
    to: init.to ?? 'beta',
    kind: init.kind ?? 'message',
    budget: init.budget ?? 2,
  });
}

describe('deliver 双层会合（盘面会合 §一）', () => {
  it('活体会合：锁在且可达 → 直投 ipc，回 ack fresh', async () => {
    const received: unknown[] = [];
    const address = socketPathFor(ROOT, 'beta');
    const server = await listenIpc(address, (payload) => { received.push(payload); return { ack: 'ok', fresh: true }; });
    try {
      fs.mkdirSync(path.join(ROOT, 'agents', 'beta'), { recursive: true });
      acquireActivationLock(path.join(ROOT, 'agents', 'beta'), { pid: process.pid, bootId: 'boot-1', acquiredAt: new Date().toISOString(), transportHint: address });
      const res = await deliver(paths, env());
      expect(res.channel).toBe('direct');
      if (res.channel === 'direct') expect(res.fresh).toBe(true);
      expect(received.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('幂等命中：接收方回 fresh=false 仍算送达（direct 通道语义透传）', async () => {
    const address = socketPathFor(ROOT, 'beta');
    const server = await listenIpc(address, () => ({ ack: 'ok', fresh: false }));
    try {
      fs.mkdirSync(path.join(ROOT, 'agents', 'beta'), { recursive: true });
      acquireActivationLock(path.join(ROOT, 'agents', 'beta'), { pid: process.pid, bootId: 'boot-2', acquiredAt: new Date().toISOString(), transportHint: address });
      const res = await deliver(paths, env());
      expect(res.channel).toBe('direct');
      if (res.channel === 'direct') expect(res.fresh).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('离线会合：无锁 → 原子落对端 inbox/<requestId>.json（文件名即幂等键）', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'beta'), { recursive: true });
    const e = env({ uuid: 'conv-1', requestId: 'rq-inbox-1' });
    const res = await deliver(paths, e);
    expect(res.channel).toBe('inbox');
    if (res.channel === 'inbox') expect(res.requestId).toBe('rq-inbox-1');
    const file = path.join(ROOT, 'agents', 'beta', 'sessions', 'conv-1', 'inbox', 'rq-inbox-1.json');
    expect(fs.existsSync(file)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as Envelope;
    expect(stored.requestId).toBe('rq-inbox-1');
    expect(stored.uuid).toBe('conv-1');
  });

  it('陈锁降级：锁在但连接不可达 → 不抛错，落 inbox（信等人，不猜）', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'beta'), { recursive: true });
    // 死 pid + 无人监听的地址：锁读到但连不上
    acquireActivationLock(path.join(ROOT, 'agents', 'beta'), { pid: process.pid, bootId: 'boot-3', acquiredAt: new Date().toISOString(), transportHint: socketPathFor(ROOT, 'ghost') });
    const res = await deliver(paths, env({ requestId: 'rq-stale' }), { connectTimeoutMs: 1_500 });
    expect(res.channel).toBe('inbox');
    expect(fs.existsSync(path.join(ROOT, 'agents', 'beta', 'sessions', 'u-deliver', 'inbox', 'rq-stale.json'))).toBe(true);
  });

  it('回程对称：同一函数反向投（beta→alpha 亦然）——机制双向对称', async () => {
    fs.mkdirSync(path.join(ROOT, 'agents', 'alpha'), { recursive: true });
    const res = await deliver(paths, env({ sender: 'beta', to: 'alpha', uuid: 'conv-2', requestId: 'rq-back' }));
    expect(res.channel).toBe('inbox');
    expect(fs.existsSync(path.join(ROOT, 'agents', 'alpha', 'sessions', 'conv-2', 'inbox', 'rq-back.json'))).toBe(true);
  });
});