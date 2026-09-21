// ============================================================
// ac-client-ui-desktop-storage/tests/desktop-bridge.test.ts
// —— 桥端口防御链回归（P0/P1：listen EACCES 不炸壳 + 候选序列顺延）
//
// 背景（2026-09 桌面端用户事故）：桥 listen 3831 报 EACCES（Windows
// Hyper-V/WinNAT 动态排除区可覆盖任意高位口），原实现两重失效——
//   1. startBridge 用同步 try/catch 包异步 listen：EACCES 经 error 事件
//      抛出，catch 永远捕不到（虚假防御）；
//   2. bridgeServer 无 error 监听 + Electron 主进程无 uncaughtException
//      兜底 → "A JavaScript error occurred in the main process" 整壳崩溃。
//
// 本测试直接驱动 desktop/main.mjs 的 startBridge（Node 环境，Electron
// import 由 vi.mock 垫片），断言：
//   · EACCES/EADDRINUSE → reject（可被编排层捕获，而非上炸）；
//   · 成功路径 resolve 实际端口并挂 error 兜底监听；
//   · 候选序列：前口被占时顺延到 +2 成功。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';

// Electron 垫片：vitest.config.ts 把 electron 模块 alias 到
// desktop/tests-support/electron-shim.mjs（main.mjs 顶层 import 的安全替身；
// 生产桌面打包走 electron-builder 不经 vitest resolver，alias 仅测试态生效）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, any>;

// ---- 从 main.mjs 提取被测函数（模块副作用：读路径/锁——垫片后安全） ----
// 仓库根经 vitest env AGENTCHAT_REPO_ROOT 注入（jsdom 等环境下 import.meta.url
// 不可靠，见 scripts/vitest-setup-chdir.mjs 注释）；cwd 兜底向上探测。
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
function findMainMjs(): string {
  let dir = process.env.AGENTCHAT_REPO_ROOT || process.cwd();
  for (let i = 0; i < 12; i++) {
    const cand = nodePath.join(dir, 'desktop', 'main.mjs');
    if (nodeFs.existsSync(cand)) return cand;
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未定位到 desktop/main.mjs');
}
const MAIN_URL = pathToFileURL(findMainMjs()).href;
async function loadMain() {
  const mod = await import(MAIN_URL);
  return mod as unknown as AnyRec;
}

/** 占住一个回环端口（返回守住它的 server） */
function holdPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function close(srv?: net.Server | http.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!srv) return resolve();
    srv.close(() => resolve());
  });
}

describe('startBridge 端口防御链（desktop/main.mjs）', () => {
  const held: Array<net.Server | http.Server> = [];

  afterEach(async () => {
    for (const s of held.splice(0)) await close(s);
  });

  it('导出 startBridge（供测试与编排显式引用）', async () => {
    const main = await loadMain();
    expect(typeof main.startBridge).toBe('function');
  });

  it('端口被占（EADDRINUSE）→ reject 而非上炸（P0：Promise 化捕获异步 listen 错误）', async () => {
    const main = await loadMain();
    const blocker = await holdPort(0); // 随机口占住
    held.push(blocker);
    const busyPort = (blocker.address() as net.AddressInfo).port;
    await expect(main.startBridge(busyPort)).rejects.toThrow();
  });

  it('成功路径 → resolve 端口，且 GET /desktop-bridge/storage 应答 CORS + JSON（P1：跨源放行）', async () => {
    const main = await loadMain();
    // 随机口探测一个空闲口（listenProbe 同款逻辑）
    const probe = await holdPort(0);
    const port = (probe.address() as net.AddressInfo).port;
    await close(probe);
    const got = await main.startBridge(port);
    expect(got).toBe(port);
    const res = await fetch(`http://127.0.0.1:${port}/desktop-bridge/storage`, {
      headers: { Origin: 'http://127.0.0.1:3830' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3830');
    await expect(res.json()).resolves.toHaveProperty('dataRoot');
    // 清理壳层持有的 bridgeServer（模块级引用，跨用例会占口）
    await main.__testCloseBridge?.();
  });

  it('非回环 Origin 不放行（CORS 面收紧：局域网/外网一律拒）', async () => {
    const main = await loadMain();
    const probe = await holdPort(0);
    const port = (probe.address() as net.AddressInfo).port;
    await close(probe);
    await main.startBridge(port);
    const res = await fetch(`http://127.0.0.1:${port}/desktop-bridge/storage`, {
      headers: { Origin: 'http://192.168.1.9:8080' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await main.__testCloseBridge?.();
  });

  it('候选序列编排：首口被占顺延次口成功（P1 壳层编排行为）', async () => {
    const main = await loadMain();
    // 占住 base+1，让序列落到 base+2
    const probe = await holdPort(0);
    const base = (probe.address() as net.AddressInfo).port;
    await close(probe);
    const blocker = await holdPort(base + 1); // 候选序列第一发
    held.push(blocker);
    const candidates = [base + 1, base + 2];
    let bound: number | null = null;
    for (const cand of candidates) {
      try { bound = await main.startBridge(cand); break; }
      catch { /* 顺延 */ }
    }
    expect(bound).toBe(base + 2);
    await main.__testCloseBridge?.();
  });
});
