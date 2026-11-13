// ============================================================
// ipc-cr1046.test.ts —— onFrame 失败/超时失败面回归（cr-1046）
// 现场：邮局 dispatch 的 uuid 登记冲突 throw 被 listenIpc 静默吞 →
// 壳 IpcClient.request 永挂（无超时、无错误帧）→ postReply 卡死 →
// driveRun finally 永不执行 → activeRuns 泄漏（三壳 busy 永真）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listenIpc, socketPathFor, IpcClient } from '../src/index.ts';

const ROOT = path.resolve('sandbox', 'test-ipc-cr1046-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('cr-1046 ipc 失败面闭环', () => {
  it('onFrame reject → 回 __ipcReject 错误帧，发送方 request reject（不永挂）', async () => {
    const address = socketPathFor(ROOT, 'boom');
    const server = await listenIpc(address, () => { throw new Error('uuid 登记冲突：news~news 已登记 [designer,news] 来信 [news,user]'); });
    const client = new IpcClient();
    await client.connect(address);
    await expect(client.send({ any: 1 })).rejects.toThrow(/对端处理失败：uuid 登记冲突/);
    client.close();
    await server.close();
  });

  it('onFrame 异步 reject（Promise rejection）同款回错误帧', async () => {
    const address = socketPathFor(ROOT, 'async-boom');
    const server = await listenIpc(address, async () => { throw new Error('async fail'); });
    const client = new IpcClient();
    await client.connect(address);
    await expect(client.send({ x: 1 })).rejects.toThrow(/对端处理失败：async fail/);
    client.close();
    await server.close();
  });

  it('对端不回帧（半死）→ 缺省超时 reject', async () => {
    const address = socketPathFor(ROOT, 'silent');
    const server = await listenIpc(address, () => undefined);
    const client = new IpcClient();
    await client.connect(address);
    await expect(client.request({ y: 1 }, () => true, 200)).rejects.toThrow(/ipc 回帧超时/);
    client.close();
    await server.close();
  });

  it('谓词等待中收到错误帧 → reject（谓词未命中也先判错误帧）', async () => {
    const address = socketPathFor(ROOT, 'pred-boom');
    const server = await listenIpc(address, () => { throw new Error('pred fail'); });
    const client = new IpcClient();
    await client.connect(address);
    // 谓词恒 false——错误帧必须穿透谓词直接 reject
    await expect(client.request({ z: 1 }, () => false, 1000)).rejects.toThrow(/对端处理失败：pred fail/);
    client.close();
    await server.close();
  });
});