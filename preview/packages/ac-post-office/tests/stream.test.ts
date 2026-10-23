// ============================================================
// M7.2 StreamTap 单测：壳 ipc 监听 → tap 订阅 → 旁带帧到达
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { encodeFrame, socketPathFor } from 'ac-envelope-core';
import { tapShellStream } from '../src/stream.ts';

const ROOT = path.join('preview', 'sandbox', 'test-tap-' + process.pid);
// 用例内建目录无 afterEach 清理（cr-549 顺带）：历届运行在 preview/sandbox 积压
// test-tap-<pid> 目录——与 sandbox 残留清理同族，补钩子根治。
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('M7.2 StreamTap（宿主订阅半边）', () => {
  it('壳发旁带帧 → tap 收到（同连接信封/ack 混走不误触）', async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    const addr = socketPathFor(path.resolve(ROOT), 'tap-' + process.pid); // win32 named pipe
    const pending: Buffer[] = [];
    let conn: net.Socket | null = null;
    const server = net.createServer((sock) => {
      conn = sock;
      for (const b of pending.splice(0)) sock.write(b);
    });
    await new Promise<void>((res) => server.listen(addr, res));
    const received: unknown[] = [];
    const tap = await tapShellStream(addr, (f) => received.push(f));
    // 壳侧模拟：向 tap 连接写旁带帧 + 信封帧（应只收旁带）
    const shellWrite = (frame: unknown) => {
      const buf = encodeFrame(frame);
      if (conn !== null) conn.write(buf);
      else pending.push(buf);
      return new Promise((r) => setTimeout(r, 50));
    };
    await shellWrite({ stream: 's1', kind: 'delta', text: '流式' });
    await shellWrite({ ack: 'req-1', fresh: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([{ stream: 's1', kind: 'delta', text: '流式' }]);
    tap.close();
    server.close();
  });
});
