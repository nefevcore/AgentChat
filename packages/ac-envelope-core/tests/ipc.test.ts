// ============================================================
// ipc.test.ts —— IpcClient 对端关闭感知回归（cr-991）
// 现场：宿主 PostOffice 连接池缓存 IpcClient，壳 idle 退出后旧实现
// 不感知 close——池内残留「半死」socket，下一次转投直写死 pipe 刷 W；
// 在途 request 等 close 后回帧 waiter 永挂。数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listenIpc, socketPathFor, IpcClient } from '../src/index.ts';

const ROOT = path.resolve('sandbox', 'test-ipc-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('cr-991 IpcClient 对端关闭感知', () => {
  it('server 关闭 → close 即摘 socket（connected()=false），不再半死', async () => {
    const address = socketPathFor(ROOT, 'echo');
    const server = await listenIpc(address, () => ({ ack: 'ok', fresh: true }));
    const client = new IpcClient();
    await client.connect(address);
    expect(client.connected()).toBe(true);
    await server.close();
    await new Promise((r) => setTimeout(r, 100)); // close 事件送达
    expect(client.connected()).toBe(false);
    client.close();
  });

  it('在途 request 逢对端退出 → reject（不永挂）', async () => {
    const address = socketPathFor(ROOT, 'slow');
    // 不回帧的 server：请求挂起期间断连
    const server = await listenIpc(address, () => undefined);
    const client = new IpcClient();
    await client.connect(address);
    const req = client.request({ hello: 1 }, (f) => (f as { ack?: unknown }).ack === 'ok');
    await server.close();
    await expect(req).rejects.toThrow(/连接已关闭/);
    client.close();
  });

  it('断连后的客户端再 request → 同步抛 ipc 未连接', async () => {
    const address = socketPathFor(ROOT, 'gone');
    const server = await listenIpc(address, () => ({ ack: 'ok', fresh: true }));
    const client = new IpcClient();
    await client.connect(address);
    await server.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(() => client.send({ x: 1 })).toThrow(/ipc 未连接/);
    client.close();
  });
});
