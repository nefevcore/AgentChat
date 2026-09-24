// ============================================================
// ac-client-ui-desktop-storage/tests/desktop-update.test.ts
// —— 桌面壳更新面回归（静默预下载 + sha256/size 双校验 + 桥路由）
//
// 需求背景（2026-09 用户裁决：不做静默安装；静默预下载免打扰）：
//   · 壳层发现新版即后台下载安装包（哈希/大小双校验），完成不提醒；
//   · 版本面板经桥见就绪态，点「安装」才拉起安装器（win=NSIS 向导，
//     覆盖安装自动带出 HKCU InstallLocation 记的原目录——NSIS 模板
//     multiUser.nsh setInstallModePerUser 行为，非壳层职责）；
//   · 异常包（哈希/大小不符）绝不进 ready 态——CI 侧另有上传后读回
//     校验（desktop.yml），双闸拦「发布异常安装包」。
//
// 测试直驱 desktop/main.mjs（electron 由 vitest alias 垫片），状态文件
// 落 os.tmpdir() 隔离目录（updatesDir 是模块常量，用 env 隔离不可行，
// 以覆盖 lastManifest + 直接驱动纯函数/桥路由为主干）。
// ============================================================
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { pathToFileURL } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, any>;

function findMainMjs(): string {
  let dir = process.env.AGENTCHAT_REPO_ROOT || process.cwd();
  for (let i = 0; i < 12; i++) {
    const cand = path.join(dir, 'desktop', 'main.mjs');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未定位到 desktop/main.mjs');
}

const mainPromise = import(pathToFileURL(findMainMjs()).href);

function holdPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function freePort(): Promise<number> {
  return holdPort(0).then(async (srv) => {
    const p = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return p;
  });
}

function close(srv?: net.Server | http.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!srv) return resolve();
    srv.close(() => resolve());
  });
}

describe('pickUpdateAsset（manifest → 本机安装包挑选，纯函数）', () => {
  it('win32 → 最高分 exe（同 arch 加权 > all > 异 arch；blockmap 排除）', async () => {
    const main = (await mainPromise) as unknown as AnyRec;
    const manifest = {
      releases: [{
        version: '9.9.9',
        files: [
          { name: 'AgentChat Setup 9.9.9.exe', platform: 'windows', arch: 'x64', size: 1, sha256: 'a', url: '/9.9.9/AgentChat Setup 9.9.9.exe' },
          { name: 'AgentChat Setup 9.9.9.exe.blockmap', platform: 'windows', arch: 'x64', size: 1, sha256: 'b', url: '/9.9.9/AgentChat Setup 9.9.9.exe.blockmap' },
          { name: 'AgentChat-9.9.9-arm64.dmg', platform: 'macos', arch: 'arm64', size: 1, sha256: 'c', url: '/9.9.9/AgentChat-9.9.9-arm64.dmg' },
          { name: 'AgentChat-9.9.9.AppImage', platform: 'linux', arch: 'x64', size: 1, sha256: 'd', url: '/9.9.9/AgentChat-9.9.9.AppImage' },
        ],
      }],
    };
    const asset = main.pickUpdateAsset(manifest, 'win32', 'x64');
    expect(asset?.name).toBe('AgentChat Setup 9.9.9.exe');
    expect(asset?.version).toBe('9.9.9');
    const none = main.pickUpdateAsset({ releases: [] }, 'win32', 'x64');
    expect(none).toBeNull();
  });

  it('darwin/arm64 → arm64 dmg 胜出（arch 加权优先于扩展名评分）', async () => {
    const main = (await mainPromise) as unknown as AnyRec;
    const manifest = {
      releases: [{
        version: '9.9.9',
        files: [
          { name: 'AgentChat-9.9.9.dmg', platform: 'macos', arch: 'x64', size: 1, sha256: 'x', url: '/9.9.9/AgentChat-9.9.9.dmg' },
          { name: 'AgentChat-9.9.9-arm64.zip', platform: 'macos', arch: 'arm64', size: 1, sha256: 'y', url: '/9.9.9/AgentChat-9.9.9-arm64.zip' },
        ],
      }],
    };
    expect(main.pickUpdateAsset(manifest, 'darwin', 'arm64')?.name).toBe('AgentChat-9.9.9-arm64.zip');
  });
});

describe('cmpVersion（三段语义化比较）', () => {
  it('升序/相等/降序', async () => {
    const main = (await mainPromise) as unknown as AnyRec;
    expect(main.cmpVersion('0.9.0', '0.8.13')).toBe(1);
    expect(main.cmpVersion('0.8.13', '0.8.13')).toBe(0);
    expect(main.cmpVersion('0.8.9', '0.8.13')).toBeLessThan(0); // 符号语义（返回原始差值）
  });
});

describe('下载链路（downloadInstallerAsync → 校验 → 状态面 → install 路由）', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let main: AnyRec;

  beforeEach(async () => {
    main = (await mainPromise) as unknown as AnyRec;
    main.__testSetRetryDelay(0); // 退避归零：用例不付真实等待
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  /** 起 http 服务当「下载服务器」+ 桥，跑一遍完整链 */
  it('正常链：下载 → sha256/size 通过 → ready → install 拉起（win 形态覆盖测试钩子）', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    const payload = Buffer.from('fake-installer-bytes-0123456789');
    const sha = createHash('sha256').update(payload).digest('hex');
    // 下载源（返回固定字节 + content-length）
    const dlSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((r) => dlSrv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => close(dlSrv));
    const dlPort = (dlSrv.address() as net.AddressInfo).port;
    const asset = {
      version: '9.9.9',
      name: 'agentchat-test-setup.exe',
      platform: 'windows',
      arch: 'x64',
      size: payload.length,
      sha256: sha,
      url: `http://127.0.0.1:${dlPort}/pkg.exe`,
    };
    await main.downloadInstallerAsync(asset);
    // 状态面经桥读（间接验证 readUpdateState/updateStatusJson 形状）
    const st = main.updateStatusJson();
    expect(st.status).toBe('ready');
    expect(st.version).toBe('9.9.9');
    expect(st.fileName).toBe('agentchat-test-setup.exe');
    expect(st.size).toBe(payload.length);
    // install 路由经真桥：startBridge 起 http 面打 POST install（win 测试态
    // platform=win32 走 spawn 真路径？——垫片环境不可真拉起，直接驱动路由函数不可行，
    // 以 installLauncherOverride 钩子验证编排）
    let launched: string | null = null;
    main.__testSetInstallLauncher(async (f: string) => { launched = f; });
    const bridgePort = await freePort();
    await main.startBridge(bridgePort);
    cleanups.push(() => main.__testCloseBridge?.());
    const res = await fetch(`http://127.0.0.1:${bridgePort}/desktop-bridge/update/install`, { method: 'POST' });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50)); // 拉起异步
    expect(launched).toBeTruthy();
    expect(String(launched)).toContain('agentchat-test-setup.exe');
  });

  it('异常包：sha256 不符 → failed + 半包清除（异常安装包绝不进 ready）', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    const payload = Buffer.from('corrupted-transfer');
    const dlSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((r) => dlSrv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => close(dlSrv));
    const asset = {
      version: '9.9.8',
      name: 'agentchat-bad-hash.exe',
      platform: 'windows',
      arch: 'x64',
      size: payload.length,
      sha256: '0'.repeat(64), // 故意错误
      url: `http://127.0.0.1:${(dlSrv.address() as net.AddressInfo).port}/pkg.exe`,
    };
    await main.downloadInstallerAsync(asset);
    const st = main.updateStatusJson();
    expect(st.status).toBe('failed');
    expect(String(st.error)).toContain('sha256');
    // 半包已清（updatesDir 下无该文件）
    const updates = main.__testUpdatesDir as string;
    expect(fs.existsSync(path.join(updates, 'agentchat-bad-hash.exe'))).toBe(false);
  });

  it('异常包：size 不符 → failed（传输截断防线）', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    const payload = Buffer.from('short-bytes');
    const dlSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((r) => dlSrv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => close(dlSrv));
    const realSha = createHash('sha256').update(payload).digest('hex');
    const asset = {
      version: '9.9.7',
      name: 'agentchat-bad-size.exe',
      platform: 'windows',
      arch: 'x64',
      size: payload.length + 999, // manifest 声称更大——模拟截断
      sha256: realSha,
      url: `http://127.0.0.1:${(dlSrv.address() as net.AddressInfo).port}/pkg.exe`,
    };
    await main.downloadInstallerAsync(asset);
    const st = main.updateStatusJson();
    expect(st.status).toBe('failed');
    // 语义（2026-09 续传改造）：字节数与 manifest 不符视为「传输不完整」，
    // 走断点续传重试；重试用尽仍未补齐 → failed（绝不以半包进 ready）。
    expect(String(st.error)).toContain('传输不完整');
  });

  it('install 路由：未就绪 → 400（不拉起）', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    let launched = 0;
    main.__testSetInstallLauncher(async () => { launched += 1; });
    const bridgePort = await freePort();
    await main.startBridge(bridgePort);
    cleanups.push(() => main.__testCloseBridge?.());
    const res = await fetch(`http://127.0.0.1:${bridgePort}/desktop-bridge/update/install`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(launched).toBe(0);
  });
});

// 残料清理（隔离目录里的测试产物）
afterEach(async () => {
  try {
    const main = (await mainPromise) as unknown as AnyRec;
    const updates = main.__testUpdatesDir as string;
    fs.rmSync(updates, { recursive: true, force: true });
  } catch { /* 目录不存在 */ }
});

describe('断点续传与重试（网络抖动韧性）', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  let main: AnyRec;

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  /** 可控下载服务器：handler 收 (req, res, 第几次请求) 自行编排响应 */
  async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void) {
    let n = 0;
    const srv = http.createServer((req, res) => { n += 1; handler(req, res, n); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => {
      srv.closeAllConnections?.();
      srv.close(() => r());
    }));
    return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/pkg.exe` };
  }

  it('断流 → 续传：第二次带 Range 只取剩余字节，最终内容与 sha256 全对', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    main.__testSetRetryDelay(0);
    const payload = randomBytes(200 * 1024);
    const sha = createHash('sha256').update(payload).digest('hex');
    const CUT = 80 * 1024;
    const seen: Array<string | undefined> = [];
    const { url } = await startServer((req, res, n) => {
      seen.push(req.headers.range as string | undefined);
      if (n === 1) {
        // 第一次：声明全量长度但只发前半截就断链（模拟网络抖动）
        res.writeHead(200, { 'content-length': String(payload.length) });
        res.write(payload.subarray(0, CUT));
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      }
      const range = req.headers.range;
      if (typeof range === 'string' && range.startsWith('bytes=')) {
        const from = Number(range.slice(6).replace('-', ''));
        const rest = payload.subarray(from);
        res.writeHead(206, { 'content-length': String(rest.length) });
        res.end(rest);
        return;
      }
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });

    await main.downloadInstallerAsync({
      version: '9.9.9', name: 'resume-test.exe', platform: 'windows', arch: 'x64',
      size: payload.length, sha256: sha, url,
    });

    const dest = path.join(main.__testUpdatesDir as string, 'resume-test.exe');
    expect(main.updateStatusJson().status).toBe('ready');
    expect(fs.existsSync(dest)).toBe(true);
    const got = fs.readFileSync(dest);
    expect(got.length).toBe(payload.length);
    expect(createHash('sha256').update(got).digest('hex')).toBe(sha);
    // 关键：第二次请求确实发了 Range（续传而非重下），且 .part 已原子改名
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toMatch(/^bytes=[1-9]\d*-$/);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('服务器忽略 Range（200 全量）→ 从头写，语义仍正确', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    main.__testSetRetryDelay(0);
    const payload = randomBytes(64 * 1024);
    const sha = createHash('sha256').update(payload).digest('hex');
    const ranges: Array<string | undefined> = [];
    const { url } = await startServer((req, res, n) => {
      ranges.push(req.headers.range as string | undefined);
      if (n === 1) {
        res.writeHead(200, { 'content-length': String(payload.length) });
        res.write(payload.subarray(0, 16 * 1024));
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      }
      // 不认 Range：照旧 200 全量（旧下载面行为）
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });

    await main.downloadInstallerAsync({
      version: '9.9.8', name: 'norange-test.exe', platform: 'windows', arch: 'x64',
      size: payload.length, sha256: sha, url,
    });

    const dest = path.join(main.__testUpdatesDir as string, 'norange-test.exe');
    expect(main.updateStatusJson().status).toBe('ready');
    expect(createHash('sha256').update(fs.readFileSync(dest)).digest('hex')).toBe(sha);
    expect(ranges[1]).toMatch(/^bytes=[1-9]\d*-$/); // 客户端仍尝试续传
  });

  it('哈希不符 → 丢弃 .part 重下（坏前缀绝不续传），重试用尽 → failed', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    main.__testSetRetryDelay(0);
    const payload = randomBytes(48 * 1024);
    const ranges: Array<string | undefined> = [];
    const { url } = await startServer((req, res) => {
      ranges.push(req.headers.range as string | undefined);
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });

    await main.downloadInstallerAsync({
      version: '9.9.7', name: 'corrupt-test.exe', platform: 'windows', arch: 'x64',
      size: payload.length, sha256: '0'.repeat(64), url, // 故意错哈希
    });

    const dest = path.join(main.__testUpdatesDir as string, 'corrupt-test.exe');
    const st = main.updateStatusJson();
    expect(st.status).toBe('failed');
    expect(String(st.error)).toContain('sha256');
    expect(ranges.length).toBe(3); // 重试上限 3 次
    expect(ranges.every((r) => r === undefined)).toBe(true); // 每次都从头（未续传坏字节）
    expect(fs.existsSync(dest)).toBe(false); // 正式名无半成品
  });

  it('传输不完整（断流且不可续传）→ 保留 .part 供下次续传，重试用尽 → failed', async () => {
    main = (await mainPromise) as unknown as AnyRec;
    main.__testSetRetryDelay(0);
    const payload = randomBytes(32 * 1024);
    const { url } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.write(payload.subarray(0, 8 * 1024));
      setTimeout(() => res.socket?.destroy(), 20);
    });

    await main.downloadInstallerAsync({
      version: '9.9.6', name: 'partial-test.exe', platform: 'windows', arch: 'x64',
      size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), url,
    });

    const dest = path.join(main.__testUpdatesDir as string, 'partial-test.exe');
    expect(main.updateStatusJson().status).toBe('failed');
    expect(fs.existsSync(dest)).toBe(false);      // 正式名绝不出现半包
    expect(fs.existsSync(`${dest}.part`)).toBe(true); // 断点保留，下次续传
  });
});
